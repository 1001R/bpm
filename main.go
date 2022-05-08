package main

import (
	"crypto/rsa"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/cristalhq/jwt/v4"
	_ "github.com/lib/pq"
)

const (
	RoleParent = "parent"
	RoleChild  = "child"
)

type apiAccountData struct {
	Balance      int            `json:"balance"`
	Transactions []apiAccountTx `json:"transactions"`
}

type apiAccountTx struct {
	Date    uint   `json:"date"`
	Comment string `json:"comment"`
	Amount  int    `json:"amount"`
}

type apiRequestTx struct {
	Amount      int    `json:"amount"`
	Description string `json:"desc"`
}

type jwtClaims struct {
	jwt.RegisteredClaims
	Role    string `json:"https://jan.monster/role"`
	Account string `json:"https://jan.monster/account"`
}

var jwtPublicKey rsa.PublicKey
var db *sql.DB

func loadAccountData(account int, page int) (*apiAccountData, error) {
	accountData := &apiAccountData{Transactions: []apiAccountTx{}}
	row := db.QueryRow("SELECT balance FROM account WHERE actno = $1", account)
	err := row.Scan(&accountData.Balance)
	if err != nil {
		return nil, err
	}
	rows, err := db.Query("SELECT tstamp, descr, amount FROM transactions WHERE act = $1 ORDER BY tstamp DESC LIMIT $2 OFFSET $3", account, 10, page*10)
	if err != nil {
		return nil, err
	}
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var tx apiAccountTx
			var timestamp time.Time
			err = rows.Scan(&timestamp, &tx.Comment, &tx.Amount)
			if err != nil {
				log.Print(err)
			}
			tx.Date = uint(timestamp.Unix())
			accountData.Transactions = append(accountData.Transactions, tx)
		}
	}
	return accountData, nil

}

func getAccount(r *http.Request) (int, error) {
	rxPath := regexp.MustCompile(`^/api/(\d+)`)
	match := rxPath.FindStringSubmatch(r.URL.Path)
	if match != nil {
		account, _ := strconv.Atoi(match[1])
		return account, nil
	}
	return 0, fmt.Errorf("invalid path: %s", r.URL.Path)
}

func handleApiGetAccount(account int, w http.ResponseWriter, r *http.Request) {
	page := 0
	queryPage := r.URL.Query().Get("p")
	if queryPage != "" {
		if p, err := strconv.Atoi(queryPage); err == nil && p >= 0 {
			page = p
		}
	}
	accountData, err := loadAccountData(account, page)
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
	} else {
		if json, err := json.Marshal(accountData); err == nil {
			w.Header().Add("Cache-Control", "no-store,no-cache")
			w.Write(json)
		} else {
			w.WriteHeader(http.StatusInternalServerError)
		}
	}
}

func handleApiPostAccount(account int, sub string, w http.ResponseWriter, r *http.Request) error {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	var apiRequest apiRequestTx
	if err := json.Unmarshal(body, &apiRequest); err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stmtBalance, err := tx.Prepare("UPDATE account SET balance = balance + $1 WHERE actno = $2")
	if err != nil {
		return err
	}
	defer stmtBalance.Close()
	stmtTx, err := tx.Prepare("INSERT INTO transactions (act, sub, tstamp, amount, descr) VALUES ($1, $2, $3, $4, $5)")
	if err != nil {
		return err
	}
	defer stmtTx.Close()
	if _, err := stmtBalance.Exec(apiRequest.Amount, account); err != nil {
		return err
	}
	if _, err := stmtTx.Exec(account, sub, time.Now().UTC(), apiRequest.Amount, apiRequest.Description); err != nil {
		return err
	}
	return tx.Commit()
}

func handleApi(account int, sub string, w http.ResponseWriter, r *http.Request, role string) {
	if r.Method == http.MethodGet {
		handleApiGetAccount(account, w, r)
	} else if r.Method == http.MethodPost {
		if role == RoleChild {
			w.WriteHeader(http.StatusUnauthorized)
		} else {
			if err := handleApiPostAccount(account, sub, w, r); err != nil {
				log.Print(err)
				w.WriteHeader(http.StatusInternalServerError)
			}
		}
	}
}

func handleCorsPreflight(w http.ResponseWriter, r *http.Request) bool {
	if r.Method == http.MethodOptions {
		// methods := r.Header.Values("Access-Control-Request-Method")
		// headers := r.Header.Values("Access-Control-Request-Headers")
		origin := r.Header.Get("Origin")
		if origin == "https://jan.monster" {
			w.Header().Add("Access-Control-Request-Method", "GET")
			w.Header().Add("Access-Control-Request-Method", "POST")
			w.Header().Add("Access-Control-Allow-Origin", "https://jan.monster")
			w.WriteHeader(http.StatusNoContent)
		} else {
			w.WriteHeader(http.StatusBadRequest)
		}
		return true
	}
	return false
}

func authJWT(handler func(int, string, http.ResponseWriter, *http.Request, string)) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, r *http.Request) {
		if handleCorsPreflight(w, r) {
			return
		}
		account, err := getAccount(r)
		if err != nil {
			log.Printf("Invalid request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		auth := r.Header.Get("Authorization")
		tokenRx := regexp.MustCompile(`^Bearer\s+(\S+)`)
		tokenMatch := tokenRx.FindStringSubmatch(auth)
		if tokenMatch != nil {
			if vrfy, err := jwt.NewVerifierRS(jwt.RS256, &jwtPublicKey); err == nil {
				if token, err := jwt.Parse([]byte(tokenMatch[1]), vrfy); err == nil {
					var claims jwtClaims
					if err := json.Unmarshal(token.Claims(), &claims); err == nil {
						handler(account, claims.Subject, w, r, claims.Role)
						return
					}
				}
			}
		}
		w.WriteHeader(http.StatusUnauthorized)
	}
}

func handlePing(w http.ResponseWriter, r *http.Request) {
	log.Printf("PING from %s", r.RemoteAddr)
	w.WriteHeader(http.StatusOK)
}

func main() {
	jwtPublicKey.N = big.NewInt(0)
	jwtPublicKey.N.SetString("EF6FAEC06F92BFDB8ADBEB812090EB2F06729645286D0CFD9DE71A8DA4B518DE47C580BC25DE2732DA366C58F232551A2168A2AE884C668D5E5DF1EDE5F53152EA4AE9E0EEA1B3F6F88BC4E0693FA46E2468AF3CAD94B5A3A5D2597F851EBA99AD5B768F42C0CAA305D3E48537A4B7DF68654207BCFE77CA1F3789224F0E67FF23E4243AC14C712C7C11882FC12B431CBB2E71013667D6AABFD257FD2247F7EC4C96528D1E9E1158A7B7A68AF6AC574D767099A27357DC4C5C81CDE89B99141D350A6A7E5A484CB78DF7EE9A8759C335FB362916D9772AC792E5477428773301F3EEAB80C8A6704C289693CCCE33C385FAA1AE5CCB29755005018C395C28E447", 16)
	jwtPublicKey.E = 65537

	connStr := os.Getenv("PG_CONNECT")
	if connStr == "" {
		log.Fatal("Environment variable PG_CONNECT is not set")
	}
	var err error
	if db, err = sql.Open("postgres", connStr); err != nil {
		log.Fatal(err)
	}
	http.HandleFunc("/api/", authJWT(handleApi))
	ping := os.Getenv("PING")
	if ping != "" {
		http.HandleFunc("/"+ping, handlePing)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	http.ListenAndServe(fmt.Sprintf(":%s", port), nil)
}
