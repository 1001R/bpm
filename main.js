import Alpine from 'alpinejs'
import { initializeApp } from "firebase/app"
import { getAuth, signInWithRedirect, GoogleAuthProvider, onAuthStateChanged, signOut } from "firebase/auth"
import { 
    collection, 
    getDocs, 
    getFirestore, 
    query, 
    orderBy, 
    limit, 
    startAfter, 
    doc, 
    getDoc, 
    endBefore,
    runTransaction,
    serverTimestamp
} from 'firebase/firestore'


const firebaseConfig = {
    apiKey: "AIzaSyBq5vo3zJ2wcGX4H3rN8pql9KKvjOlWC78",
    authDomain: "bankhaus-patzmann-monster.firebaseapp.com",
    projectId: "bankhaus-patzmann-monster",
    storageBucket: "bankhaus-patzmann-monster.appspot.com",
    messagingSenderId: "541063019239",
    appId: "1:541063019239:web:3142d4c024c1991bcb0042"
}

async function init() {
    const app = initializeApp(firebaseConfig)
    const db = getFirestore(app)
    const authProvider = new GoogleAuthProvider()
    const auth = getAuth(app)
    auth.useDeviceLanguage()
    this.login = async () => await signInWithRedirect(auth, authProvider)
    onAuthStateChanged(auth, async user => {
        if (user) {
            this.logout = async () => {
                this.menu = 'logout'
                this.user = null
                this.accountNo = null
                this.db = null
                this.parent = false
                await signOut(auth)
            }
            const idTokenResult = await user.getIdTokenResult()
            if (idTokenResult.claims.account) {
                this.user = user
                this.accountNo = idTokenResult.claims.account
                this.db = db
                this.parent = idTokenResult.claims.parent ?? false
                window.dispatchEvent(new CustomEvent('refresh'))
            } else {
                await this.logout()
            }
        }
    })
}

async function fetchTransactions(pageIncrement) {
    const constraints = [orderBy('timestamp', 'desc'), limit(10)]
    if (pageIncrement && this.page + pageIncrement > 0) {
        constraints.push(pageIncrement > 0 ? startAfter(this.lastTransaction) : endBefore(this.firstTransaction))
    }
    const transactions = collection(this.db, `accounts/${this.accountNo}/transactions`)
    const docs = await getDocs(query(transactions, ...constraints))
    if (docs.empty && pageIncrement > 0) {
        this.lastPage = true
        return
    }
    const tmp = []
    let first = null
    let last = null
    docs.forEach(doc => {
        tmp.push(mapTransaction(doc.data()))
        if (!first) first = doc.data().timestamp
        last = doc.data().timestamp
    })
    this.transactions = tmp
    this.firstTransaction = first
    this.lastTransaction = last
    this.lastPage = docs.size < 10
    this.page = pageIncrement ? this.page + pageIncrement : 0
}

async function fetchBalance() {
    const account = await getDoc(doc(this.db, `accounts/${this.accountNo}`))
    this._balance = account.data().balance
}

async function saveTransaction(amount, description) {
    const accountRef = doc(this.db, `accounts/${this.accountNo}`)
    const transactionsRef = collection(accountRef, 'transactions')
    const newTxRef = doc(transactionsRef)
    await runTransaction(this.db, async tx => {
        const account = await tx.get(accountRef)
        if (account.exists()) {
            tx.update(accountRef, { balance: account.data().balance + amount })
            tx.set(newTxRef, {
                timestamp: serverTimestamp(),
                description,
                amount,
                user: this.user.uid
            })
        }
    })
    this.menu = 'transactions'
    window.dispatchEvent(new CustomEvent('refresh'))
    this.fetchBalance()
}

function intToString(i, numDigits) {
    let s = i.toString()
    return s.padStart(numDigits, '0')
}

function mapTransaction(tx) {
    return {
        timestamp: tx.timestamp,
        uiTimestamp: epochToString(tx.timestamp.toMillis() / 1000),
        description: tx.description,
        amount: tx.amount,
        uiAmount: amountToString(tx.amount)
    }
}

function epochToString(epoch) {
    const d = new Date(epoch * 1000)
    return intToString(d.getDate(), 2)
         + '.'
         + intToString(d.getMonth() + 1, 2)  
         + '.'
         + intToString(d.getFullYear(), 4)
         /*
         + ' '
         + intToString(d.getHours(), 2)
         + ':'
         + intToString(d.getMinutes(), 2)
         */
}

function amountToString(cents) {
    const negative = cents < 0
    let s = cents.toString().replace(/^-/, '')
    const n = s.length
    if (n < 3) {
        s = '0,' + s + (n === 1 ? '0' : '')
    } else {
        s = s.substring(0, n - 2) + ',' + s.substring(n - 2)
    }
    if (negative) s = '-' + s
    return '€ ' + s.padStart(8)
}

function amountFromString(s) {
    const match = s.trim().match(/^(\d+)(?:[,.](\d{1,2}?)0*)?$/)
    if (!match) {
        throw new Exception('Invalid amount')
    }
    const eur = Number.parseInt(match[1])
    const ct = match[2] ? Number.parseInt(match[2]) : 0
    return eur * 100 + ct
}


window.data = {
    user: null,
    parent: false,
    _balance: null,
    get balance() {
        return this._balance != null ? amountToString(this._balance) : ' '
    },
    init,
    fetchBalance,
    menu: 'transactions',
    logout() {},
    saveTransaction
}

window.transactionData = {
    validated: false,
    amount: 1,
    amountInput: '1',
    description: '',
    valid: false,
    async doSubmit(form) {
        this.valid = form.checkValidity()
        this.validated = true
        if (this.valid) {
            const amount = amountFromString(this.amount) * (this.menu === 'withdrawal' ? -1 : 1)
            await this.saveTransaction(amount, this.description)
            this.amount = 1
            this.description = ''
            this.validated = false
        }  
    }
}

window.transactionList = {
    transactions: [],
    page: 0,
    firstTransaction: null,
    lastTransaction: null,
    lastPage: false,
    next() {
        this.fetchTransactions(1)
    },
    prev() {
        this.fetchTransactions(-1)
    },
    fetchTransactions,
    refresh() {
        this.fetchTransactions()
    }
}

window.Alpine = Alpine
Alpine.start()




