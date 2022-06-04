import express from 'express'
import pg from 'pg'
import bodyParser from 'body-parser'
import session from 'cookie-session'
import crypto from 'crypto'
import njwt from 'njwt'
import axios from 'axios'
import cors from 'cors'
import 'dotenv/config'

const { Pool } = pg

async function db(tx, f) {
    const client = await pgPool.connect()
    try {
        if (tx) await client.query('BEGIN')
        const args = Array.from(arguments)
        const result = await f(client, ...args.slice(2))
        if (tx) await client.query('COMMIT')
        return result
    } catch (error) {
        if (tx) console.error('Transaction rollback due to an error:', error)
    } finally {
        client.release()
    }
}


async function fetchAccount(pgClient, accountNo, page = 0) {
    let result = await pgClient.query({
        text: 'SELECT balance FROM account WHERE actno = $1',
        values: [accountNo],
        rowMode: 'array'
    })
    if (result.rows.length == 0) {
        return {}
    }
    const accountData = {
        balance: result.rows[0][0],
        transactions: []
    }
    result = await pgClient.query({
        text: 'SELECT tstamp, descr, amount FROM transactions WHERE act = $1 ORDER BY tstamp DESC LIMIT $2 OFFSET $3',
        values: [accountNo, 10, page * 10],
        rowMode: 'array'
    })
    for (const row of result.rows) {
        const tx = {
            date: row[0].getTime(),
            comment: row[1],
            amount: row[2]
        }
        accountData.transactions.push(tx)
    }
    return accountData
}

async function newTransaction(pgClient, accountNo, sub, amount, desc) {
    await pgClient.query('UPDATE account SET balance = balance + $1 WHERE actno = $2', [amount, accountNo])
    await pgClient.query('INSERT INTO transactions (act, sub, tstamp, amount, descr) VALUES ($1, $2, $3, $4, $5)', [sub, Date.now(), amount, desc])
}

// middleware

function mwApiAuth(req, res, next) {
    if (req.session.user) {
        next()
    } else {
        res.status(401).end()
    }
}

function mwApiAccount(req, res, next) {
    if (req.params.account == req?.session?.user?.account) {
        next()
    } else {
        res.status(401).end()
    }
}

function parseJwtToken(tokenStr) {
    return new Promise((resolve, reject) => {
        njwt.verify(tokenStr, JWT_KEY, 'RS256', (err, jwt) => {
            if (err) {
                reject(err)
            }
            const user = {
                sub: jwt.body.sub,
                name: jwt.body.name,
                role: jwt.body['https://jan.monster/role'],
                account: jwt.body['https://jan.monster/account']
            }
            resolve(user)            
        })    
    })
}

const JWT_KEY = crypto.createPublicKey({
    key: Buffer.from(process.env.JWT_KEY, 'base64'),
    format: 'der',
    type: 'spki',
    encoding: 'base64'
})

const pgPool = new Pool()
pgPool.on('error', err => {
    console.error('Unexpected error on idle database client', err)
    process.exit(-1)
})

const app = express()
app.set('trust proxy', true)
app.use(bodyParser.json())
app.use(cors({
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST'],
    credentials: true
}))
app.use(session({
    keys: [process.env.SESSION_KEY],
    sameSite: 'lax',
    // sameSite: 'none'
    // Cookie Options
    // maxAge: 24 * 60 * 60 * 1000 // 24 hours
}))


const apiRouter = express.Router()

apiRouter.use(mwApiAuth)
apiRouter.use('/account/:account', mwApiAccount)

apiRouter.get('/account/:account', async (req, resp) => {
    let p = 0
    if (req.query.p) {
        p = Number.parseInt(req.query.p)
        if (isNaN(p) || p < 0) p = 0
    }
    Number.parseInt(req.query.p)
    const accountData = await db(false, fetchAccount, req.params.account, p)
    resp.json(accountData)
})

apiRouter.post('/account/:account', async (req, resp) => {
    const sub = req.oidc.user.sub
    const account = req.params.account
    await db(true, newTransaction, account, sub, req.body.amount, req.body.desc)
    resp.end()
})

apiRouter.get('/user', (req, res) => res.json(req.session.user))

// app.use(express.static('C:/Development/Git/jan.monster'))
app.use('/api', apiRouter)

app.post('/auth0', async (req, res) => {
    crypto.randomBytes(32, (err, buf) => {
        if (err) {
            res.status(500).end()
        } else {
            req.session = { state: buf.toString('base64url') }
            const url = new URL(`${process.env.OAUTH_API_URL}/authorize`)
            url.searchParams.set('response_type', 'code')
            url.searchParams.set('client_id', process.env.OAUTH_CLIENT_ID)
            url.searchParams.set('redirect_uri', process.env.FRONTEND_URL)
            url.searchParams.set('state', req.session.state)
            url.searchParams.set('scope', 'openid profile')
            res.json({url: url.href})
        }
    })
})

app.post('/login', async (req, res) => {
    if (req?.session?.state !== req.body.state) {
        res.status(401).end()
        return
    }

    const params = new URLSearchParams()
    params.set('grant_type', 'authorization_code')
    params.set('client_id', process.env.OAUTH_CLIENT_ID)
    params.set('client_secret', process.env.OAUTH_CLIENT_SECRET)
    params.set('code', req.body.code)
    params.set('redirect_uri', process.env.FRONTEND_URL)
    
    try {
        const tokenResp = await axios.post(`${process.env.OAUTH_API_URL}/oauth/token`, params)
        const idToken = tokenResp.data['id_token']
        const user = await parseJwtToken(idToken)
        req.session = {user}
        res.status(204).end()
    } catch (err) {
        console.log(err)
        req.status(401).end()
    }
})

app.post('/logout', (req, res) => {
    req.session = null
    const url = new URL('https://dev-nxbvca9g.eu.auth0.com/v2/logout')
    url.searchParams.set('client_id', 'ctYa88q7rZkOAtoZM0B4gyNVOjyXOAzN')
    url.searchParams.set('returnTo', `${process.env.FRONTEND_URL}/#logout`)
    res.json({url: url.toString()})
})

if (process.env.PING) {
    app.get(`/${process.env.PING}`, (req, res) => res.end())
}

app.listen(3000, () => {
    console.log(`BPM up and running`)
})