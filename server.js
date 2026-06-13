const express = require("express");
const sql = require("mssql");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// ── DB Config ─────────────────────────────────────────
const dbConfig = {
  user: "sa",
  password: "123",
  server: "127.0.0.1",
  database: "Online_LMS24", // matches your SQL file
  options: {
    instanceName: "SQLEXPRESS",
    encrypt: false,
    trustServerCertificate: true,
  },
  // No port: conflicts with instanceName
};

let pool;

async function connectDB() {
  try {
    pool = await sql.connect(dbConfig);
    console.log("✅ Connected to SQL Server");
  } catch (err) {
    console.error("❌ DB Connection Failed:", err.message);
    process.exit(1);
  }
}

// ── AUTH ──────────────────────────────────────────────

// POST /login
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    // Always check Admins first
    const adminResult = await pool
      .request()
      .input("email", sql.VarChar, email)
      .input("password", sql.VarChar, password)
      .query(
        "SELECT * FROM Admins WHERE Email = @email AND Password = @password",
      );

    if (adminResult.recordset.length > 0) {
      return res.json({ role: "admin", token: "admin-token-" + Date.now() });
    }

    // Then check Users
    const userResult = await pool
      .request()
      .input("email", sql.VarChar, email)
      .input("password", sql.VarChar, password)
      .query(
        "SELECT * FROM Users WHERE Email = @email AND Password = @password",
      );

    if (userResult.recordset.length === 0)
      return res.status(401).json({ message: "Invalid credentials" });

    const user = userResult.recordset[0];

    // Get subscription
    const subResult = await pool
      .request()
      .input("userId", sql.Int, user.User_Id)
      .query(
        "SELECT TOP 1 * FROM User_Subscriptions WHERE User_Id = @userId ORDER BY Subscription_Id DESC",
      );

    const sub = subResult.recordset[0];
    return res.json({
      role: "user",
      token: "user-token-" + Date.now(),
      subscriptionType: sub ? sub.Subscription_Type : 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /signup
app.post("/signup", async (req, res) => {
  const { name, email, password, phone, role } = req.body;
  try {
    if (role === "admin") {
      await pool
        .request()
        .input("name", sql.VarChar, name)
        .input("email", sql.VarChar, email)
        .input("password", sql.VarChar, password)
        .query(
          "INSERT INTO Admins (Name, Email, Password) VALUES (@name, @email, @password)",
        );
      return res.json({ message: "Admin created successfully" });
    } else {
      await pool
        .request()
        .input("name", sql.VarChar, name)
        .input("email", sql.VarChar, email)
        .input("password", sql.VarChar, password)
        .input("phone", sql.VarChar, phone || null)
        .query(
          "INSERT INTO Users (Name, Email, Password, Phone) VALUES (@name, @email, @password, @phone)",
        );
      return res.json({ message: "User created successfully" });
    }
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── USER ROUTES ───────────────────────────────────────

// GET /user/full-info/email/:email
app.get("/user/full-info/email/:email", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("email", sql.VarChar, req.params.email).query(`
                SELECT U.*, US.Subscription_Type, US.Expiry_Date
                FROM Users U
                LEFT JOIN User_Subscriptions US ON U.User_Id = US.User_Id
                WHERE U.Email = @email
            `);
    if (result.recordset.length === 0)
      return res.status(404).json({ message: "User not found" });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /user/fine/email/:email
app.get("/user/fine/email/:email", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("email", sql.VarChar, req.params.email).query(`
                SELECT SUM(F.Fine_Amount) AS fineAmount
                FROM Fines F
                JOIN Users U ON F.User_Id = U.User_Id
                WHERE U.Email = @email AND F.Paid = 0
            `);
    res.json({ fineAmount: result.recordset[0].fineAmount || 0 });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /user/borrowing-history/email/:email
app.get("/user/borrowing-history/email/:email", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("email", sql.VarChar, req.params.email).query(`
                SELECT B.Borrow_Id, E.Title AS BookTitle, E.Image, E.URL,
                       B.Borrowed_On AS BorrowDate, B.Due_Date, B.Returned_On AS ReturnDate
                FROM Borrowing B
                JOIN Users U ON B.User_Id = U.User_Id
                JOIN Ebooks E ON B.Ebook_Id = E.Ebook_Id
                WHERE U.Email = @email
                ORDER BY B.Borrowed_On DESC
            `);
    res.json({ history: result.recordset });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /user/bookmarks/email/:email
app.get("/user/bookmarks/email/:email", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("email", sql.VarChar, req.params.email).query(`
                SELECT BM.Bookmark_Id, E.Title AS BookTitle, E.Image, E.URL,
                       BM.Page_Number, BM.Created_At
                FROM Bookmarks BM
                JOIN Users U ON BM.User_Id = U.User_Id
                JOIN Ebooks E ON BM.Ebook_Id = E.Ebook_Id
                WHERE U.Email = @email
            `);
    res.json({ bookmarks: result.recordset });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /change-password/:email
app.put("/change-password/:email", async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    const check = await pool
      .request()
      .input("email", sql.VarChar, req.params.email)
      .input("password", sql.VarChar, currentPassword)
      .query(
        "SELECT * FROM Users WHERE Email = @email AND Password = @password",
      );

    if (check.recordset.length === 0)
      return res.status(401).json({ message: "Current password is incorrect" });

    await pool
      .request()
      .input("email", sql.VarChar, req.params.email)
      .input("newPassword", sql.VarChar, newPassword)
      .query("UPDATE Users SET Password = @newPassword WHERE Email = @email");

    res.json({ message: "Password updated successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /change-subscription/:email
app.put("/change-subscription/:email", async (req, res) => {
  const { subscriptionType } = req.body;
  try {
    const userResult = await pool
      .request()
      .input("email", sql.VarChar, req.params.email)
      .query("SELECT User_Id FROM Users WHERE Email = @email");

    if (userResult.recordset.length === 0)
      return res.status(404).json({ message: "User not found" });

    const userId = userResult.recordset[0].User_Id;

    await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("subType", sql.Int, subscriptionType)
      .query(
        "UPDATE User_Subscriptions SET Subscription_Type = @subType WHERE User_Id = @userId",
      );

    res.json({ message: "Subscription updated" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /extend-expiry/:email
app.put("/extend-expiry/:email", async (req, res) => {
  try {
    const userResult = await pool
      .request()
      .input("email", sql.VarChar, req.params.email)
      .query("SELECT User_Id FROM Users WHERE Email = @email");

    if (userResult.recordset.length === 0)
      return res.status(404).json({ message: "User not found" });

    const userId = userResult.recordset[0].User_Id;

    await pool.request().input("userId", sql.Int, userId)
      .query(`UPDATE User_Subscriptions 
                    SET Expiry_Date = DATEADD(YEAR, 1, ISNULL(Expiry_Date, GETDATE()))
                    WHERE User_Id = @userId`);

    res.json({ message: "Subscription extended by 1 year" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── EBOOKS ────────────────────────────────────────────

// GET /Ebooks
app.get("/Ebooks", async (req, res) => {
  try {
    const result = await pool.request().query(`
            SELECT E.*, A.Author_Name, C.Category_Name
            FROM Ebooks E
            LEFT JOIN Authors A ON E.Author_Id = A.Author_Id
            LEFT JOIN Categories C ON E.Category_Id = C.Category_Id
        `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /Ebooks
app.post("/Ebooks", async (req, res) => {
  const {
    Title,
    Author_Id,
    Category_Id,
    ISBN,
    Publication_Year,
    File_Format,
    Subscription_Type,
    Uploaded_By,
    Image,
    URL,
  } = req.body;
  try {
    await pool
      .request()
      .input("title", sql.VarChar, Title)
      .input("authorId", sql.Int, Author_Id)
      .input("categoryId", sql.Int, Category_Id)
      .input("isbn", sql.VarChar, ISBN)
      .input("pubYear", sql.Int, Publication_Year)
      .input("format", sql.VarChar, File_Format)
      .input("subType", sql.Int, Subscription_Type)
      .input("uploadedBy", sql.Int, Uploaded_By)
      .input("image", sql.VarChar, Image)
      .input("url", sql.VarChar, URL).query(`INSERT INTO Ebooks 
                (Title, Author_Id, Category_Id, ISBN, Publication_Year, File_Format, Subscription_Type, Uploaded_By, Image, URL)
                VALUES (@title, @authorId, @categoryId, @isbn, @pubYear, @format, @subType, @uploadedBy, @image, @url)`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /Ebooks/:id
app.delete("/Ebooks/:id", async (req, res) => {
  try {
    await pool
      .request()
      .input("id", sql.Int, req.params.id)
      .query("DELETE FROM Ebooks WHERE Ebook_Id = @id");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /ebooks/category/:categoryId
app.get("/ebooks/category/:categoryId", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("categoryId", sql.Int, req.params.categoryId).query(`
                SELECT E.*, A.Author_Name
                FROM Ebooks E
                LEFT JOIN Authors A ON E.Author_Id = A.Author_Id
                WHERE E.Category_Id = @categoryId
            `);
    res.json({ ebooks: result.recordset });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /ebooks-by-author/:authorName
app.get("/ebooks-by-author/:authorName", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("authorName", sql.VarChar, req.params.authorName).query(`
                SELECT E.*
                FROM Ebooks E
                JOIN Authors A ON E.Author_Id = A.Author_Id
                WHERE A.Author_Name = @authorName
            `);
    res.json({ ebooks: result.recordset });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /top-3-recommended-books
app.get("/top-3-recommended-books", async (req, res) => {
  try {
    const result = await pool.request().query("SELECT * FROM Top_3_Books");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── REVIEWS ───────────────────────────────────────────

// GET /reviews/:ebookId
app.get("/reviews/:ebookId", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("ebookId", sql.Int, req.params.ebookId)
      .query("SELECT * FROM Reviews WHERE Ebook_Id = @ebookId");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /review/:bookId
app.post("/review/:bookId", async (req, res) => {
  const { email, reviewText, rating } = req.body;
  try {
    const userResult = await pool
      .request()
      .input("email", sql.VarChar, email)
      .query("SELECT User_Id FROM Users WHERE Email = @email");

    if (userResult.recordset.length === 0)
      return res.status(404).json({ message: "User not found" });

    const userId = userResult.recordset[0].User_Id;

    await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("ebookId", sql.Int, req.params.bookId)
      .input("rating", sql.Int, rating)
      .input("reviewText", sql.Text, reviewText)
      .query(`INSERT INTO Reviews (User_Id, Ebook_Id, Rating, Review_Text)
                    VALUES (@userId, @ebookId, @rating, @reviewText)`);

    res.json({ message: "Review submitted" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── BOOKMARK ──────────────────────────────────────────

// POST /bookmark/:bookId
app.post("/bookmark/:bookId", async (req, res) => {
  const { email, pageNumber } = req.body;
  try {
    const userResult = await pool
      .request()
      .input("email", sql.VarChar, email)
      .query("SELECT User_Id FROM Users WHERE Email = @email");

    if (userResult.recordset.length === 0)
      return res.status(404).json({ message: "User not found" });

    const userId = userResult.recordset[0].User_Id;

    await pool
      .request()
      .input("userId", sql.Int, userId)
      .input("ebookId", sql.Int, req.params.bookId)
      .input("pageNumber", sql.Int, pageNumber || 0)
      .query(`INSERT INTO Bookmarks (User_Id, Ebook_Id, Page_Number)
                    VALUES (@userId, @ebookId, @pageNumber)`);

    res.json({ message: "Bookmarked successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── CATEGORIES & AUTHORS ──────────────────────────────

// GET /Categories
app.get("/Categories", async (req, res) => {
  try {
    const result = await pool.request().query("SELECT * FROM Categories");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /Authors
app.get("/Authors", async (req, res) => {
  try {
    const result = await pool.request().query("SELECT * FROM Authors");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── USERS (Admin) ─────────────────────────────────────

// GET /Users
app.get("/Users", async (req, res) => {
  try {
    const result = await pool
      .request()
      .query(
        "SELECT User_Id, Name, Email, Phone, Registration_Date FROM Users",
      );
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /Users
app.post("/Users", async (req, res) => {
  const { Name, Email, Password, Phone } = req.body;
  try {
    await pool
      .request()
      .input("name", sql.VarChar, Name)
      .input("email", sql.VarChar, Email)
      .input("password", sql.VarChar, Password)
      .input("phone", sql.VarChar, Phone || null)
      .query(
        "INSERT INTO Users (Name, Email, Password, Phone) VALUES (@name, @email, @password, @phone)",
      );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /Users/:id
app.delete("/Users/:id", async (req, res) => {
  try {
    await pool
      .request()
      .input("id", sql.Int, req.params.id)
      .query("DELETE FROM Users WHERE User_Id = @id");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /download-history/:userId
app.get("/download-history/:userId", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("userId", sql.Int, req.params.userId)
      .query("SELECT * FROM Download_History WHERE User_Id = @userId");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /access-logs/:userId
app.get("/access-logs/:userId", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("userId", sql.Int, req.params.userId)
      .query("SELECT * FROM Access_Log WHERE User_Id = @userId");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /borrowing-history/:userId
app.get("/borrowing-history/:userId", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("userId", sql.Int, req.params.userId)
      .query("SELECT * FROM Borrowing WHERE User_Id = @userId");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /fines/:userId
app.get("/fines/:userId", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("userId", sql.Int, req.params.userId)
      .query("SELECT * FROM Fines WHERE User_Id = @userId");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /fines/pay/:fineId
app.put("/fines/pay/:fineId", async (req, res) => {
  try {
    await pool
      .request()
      .input("fineId", sql.Int, req.params.fineId)
      .query("UPDATE Fines SET Paid = 1 WHERE Fine_Id = @fineId");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// POST /borrow
app.post("/borrow", async (req, res) => {
  const { User_Id, Ebook_Id, Borrowed_On, Returned_On } = req.body;
  try {
    await pool
      .request()
      .input("userId", sql.Int, User_Id)
      .input("ebookId", sql.Int, Ebook_Id)
      .input("borrowedOn", sql.Date, Borrowed_On)
      .input("returnedOn", sql.Date, Returned_On || null)
      .query(`INSERT INTO Borrowing (User_Id, Ebook_Id, Borrowed_On, Returned_On)
                    VALUES (@userId, @ebookId, @borrowedOn, @returnedOn)`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// PUT /return-book/:borrowId
app.put("/return-book/:borrowId", async (req, res) => {
  try {
    await pool
      .request()
      .input("borrowId", sql.Int, req.params.borrowId)
      .query(
        `UPDATE Borrowing SET Returned_On = CAST(GETDATE() AS DATE) WHERE Borrow_Id = @borrowId`,
      );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── ADMINS ────────────────────────────────────────────

// GET /Admins
app.get("/Admins", async (req, res) => {
  try {
    const result = await pool
      .request()
      .query("SELECT Admin_Id, Name, Email, Created_At FROM Admins");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// DELETE /Admins/:id
app.delete("/Admins/:id", async (req, res) => {
  try {
    await pool
      .request()
      .input("id", sql.Int, req.params.id)
      .query("DELETE FROM Admins WHERE Admin_Id = @id");
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin-info/email/:email
app.get("/admin-info/email/:email", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("email", sql.VarChar, req.params.email)
      .query("SELECT * FROM Admins WHERE Email = @email");
    if (result.recordset.length === 0)
      return res.status(404).json({ message: "Admin not found" });
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/:email/books
app.get("/admin/:email/books", async (req, res) => {
  try {
    const adminResult = await pool
      .request()
      .input("email", sql.VarChar, req.params.email)
      .query("SELECT Admin_Id FROM Admins WHERE Email = @email");

    if (adminResult.recordset.length === 0) return res.json([]);

    const adminId = adminResult.recordset[0].Admin_Id;
    const result = await pool
      .request()
      .input("adminId", sql.Int, adminId)
      .query("SELECT * FROM Ebooks WHERE Uploaded_By = @adminId");
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// GET /admin/:adminId/upload-stats
app.get("/admin/:adminId/upload-stats", async (req, res) => {
  try {
    const result = await pool
      .request()
      .input("adminId", sql.Int, req.params.adminId).query(`
                SELECT COUNT(*) AS TotalBooks,
                       (SELECT TOP 1 Category_Id FROM Ebooks WHERE Uploaded_By = @adminId
                        GROUP BY Category_Id ORDER BY COUNT(*) DESC) AS TopCategory
                FROM Ebooks WHERE Uploaded_By = @adminId
            `);
    res.json(result.recordset[0]);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── ROOT ──────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ message: "✅ Online LMS API is running" });
});

// ── START ─────────────────────────────────────────────
connectDB().then(() => {
  app.listen(5000, () =>
    console.log("🚀 Backend running on http://localhost:5000"),
  );
});
