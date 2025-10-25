/**
 * bankbotServer.js
 * 
 * AI-powered BankBot server using ES Modules.
 * - Accepts user queries via `/bankbot-stream` and streams AI responses.
 * - Serves static files (e.g., bankbot.js).
 * - Provides an endpoint to upload bank statements, uses OCR.space to extract text,
 *   and stores the extracted text with the user's name in the "Bank-statements" collection.
 */

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import path from "path";
import { fileURLToPath } from "url";
import { MongoClient } from "mongodb";
import FormData from "form-data";
import multer from "multer";
import AWS from "aws-sdk";
import dotenv from "dotenv";
import twilio from "twilio";
import Tesseract from "tesseract.js";
import { createClient } from "@supabase/supabase-js";
import axios from "axios";

dotenv.config();

import OpenAI from "openai";
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ✅ Configure AWS S3
AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION
});

const s3 = new AWS.S3();
const bucketName = process.env.S3_BUCKET_NAME;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Replace with your actual OpenAI API key
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const app = express();
const upload = multer({ dest: "tmp-uploads/" }); // ✅ Define "upload" here
app.use(bodyParser.json());
app.use(cors());

// ✅ Use .env variables securely
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER;

// ✅ Temporary OTP storage
const otpStore = new Map();


// Resolve __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static files from "public" folder (e.g., bankbot.js)
app.use(express.static(path.join(__dirname, "public")));

// ----- MongoDB Connection Setup -----
const uri = "mongodb+srv://roberthill999:4QWknhPgaRvDkF6p@chat-bot-training.2o2y4.mongodb.net/chat-bot-training?retryWrites=true&w=majority&ssl=true";
const client = new MongoClient(uri);
let db;
async function connectToDatabase() {
  try {
    await client.connect();
    db = client.db("chat-bot-training");
    console.log("✅ Connected to MongoDB!");
  } catch (err) {
    console.error("❌ MongoDB Connection Failed:", err);
    process.exit(1);
  }
}

// ----- Health Check Endpoint -----
app.get("/health", (req, res) => {
  res.status(200).send("✅ BankBot server is running!");
});


// --- Beautify AI decision helper ---
async function beautifyAiDecision(rawText) {
  if (!rawText || rawText.trim() === "") return rawText;

  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a financial summary formatter. Rewrite the given AI decision into a clear, professional structure with bold section titles. Keep it concise, factual, and polished. Use Markdown-style emphasis (e.g., **labels**).",
          },
          { role: "user", content: rawText },
        ],
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    return response.data.choices[0].message.content.trim();
  } catch (err) {
    console.error("⚠️ Beautify AI Decision Failed:", err.message);
    return rawText; // fallback if anything goes wrong
  }
}


app.post("/send-otp", async (req, res) => {
  let { phoneNumber } = req.body;

  // ✅ Ensure phone number is in +44 format
  if (phoneNumber.startsWith("07")) {
      phoneNumber = "+44" + phoneNumber.slice(1);
  }

  const otp = Math.floor(100000 + Math.random() * 900000);
  otpStore.set(phoneNumber, otp);

  try {
      await twilioClient.messages.create({
          body: `Your verification code is: ${otp}`,
          from: process.env.TWILIO_PHONE_NUMBER,
          to: phoneNumber,
      });

      console.log(`✅ OTP sent to ${phoneNumber}: ${otp}`);
      res.json({ success: true, message: "OTP sent successfully." });
  } catch (error) {
      console.error("❌ Error sending OTP:", error);
      res.status(500).json({ error: "Failed to send OTP." });
  }
});


app.post("/submit-application", async (req, res) => {
  try {
    const applicationData = req.body;

    // 🧠 Extract the raw AI decision from frontend
    const rawDecision = applicationData.ai_decision || "";

    // 🪄 Beautify AI Decision before saving
    const beautifiedDecision = await beautifyAiDecision(rawDecision);

    // 🧱 Merge beautified text back into application data
    const formattedApplication = {
      ...applicationData,
      ai_decision: beautifiedDecision,  // polished version stored
    };

    // 💾 Insert into Supabase
    const { data, error } = await supabase
      .from("loan_applications")
      .insert([formattedApplication])
      .select();

    if (error) throw error;

    console.log(`✅ Beautified AI decision saved for ${formattedApplication.first_name} ${formattedApplication.surname}`);
    res.json({ success: true, data });
  } catch (err) {
    console.error("❌ Supabase insert error:", err.message);
    res.status(500).json({ error: "Failed to store application" });
  }
});


// ---- Verify OTP ----
app.post("/verify-otp", (req, res) => {
  const { phoneNumber, otp } = req.body;
  if (!phoneNumber || !otp) {
      return res.status(400).json({ error: "Phone number and OTP are required." });
  }

  const storedOtp = otpStore.get(phoneNumber);
  if (!storedOtp) {
      return res.json({ verified: false, message: "OTP expired or not found." });
  }

  if (parseInt(otp) !== storedOtp) {
      return res.json({ verified: false, message: "Invalid OTP." });
  }

  otpStore.delete(phoneNumber); // ✅ Remove OTP after verification
  console.log(`✅ OTP verified for ${phoneNumber}`);
  res.json({ verified: true, message: "OTP verified successfully." });
});



// ----- AI Streaming Endpoint (/bankbot-stream) -----
app.post("/bankbot-stream", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "User message is required." });
  }
  try {
    // Set up SSE headers
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    // Call OpenAI API for streamed response
    const openAIResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini", // Adjust model if needed
        messages: [
          { role: "system", content: "You are an AI-powered chatbot. Answer the user queries accurately." },
          { role: "user", content: message },
        ],
        max_tokens: 16000,
        temperature: 0.7,
        stream: true,
      }),
    });
    
    if (!openAIResponse.ok) {
      const errBody = await openAIResponse.text();
      throw new Error(`OpenAI Error: ${errBody || openAIResponse.statusText}`);
    }
    
    // Use getReader() to read the streamed response
    const reader = openAIResponse.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === "data: [DONE]") {
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        if (trimmed.startsWith("data: ")) {
          try {
            const jsonData = JSON.parse(trimmed.slice("data: ".length));
            if (jsonData.choices && jsonData.choices[0].delta?.content) {
              const aiText = jsonData.choices[0].delta.content;
              res.write(`data: ${JSON.stringify({ response: aiText })}\n\n`);
            }
          } catch (err) {
            console.error("❌ Error parsing AI response:", trimmed, err);
          }
        }
      }
    }
    res.end();
  } catch (error) {
    console.error("❌ Error streaming bot response:", error);
    res.write(`data: {"error":"${error.message}"}\n\n`);
    res.end();
  }
});

// Remove the old /upload-bank-statement route entirely, or leave it unused.
// Then define a new endpoint:

app.post("/upload-ocr-result", async (req, res) => {
  const { name, extractedText } = req.body;

  if (!name || !extractedText) {
    return res.status(400).json({ error: "Missing required fields: name or extractedText." });
  }

  try {
    const { data, error } = await supabase
      .from("bank_statements")
      .insert([
        {
          user_name: name,
          extracted_text: extractedText
        }
      ])
      .select();

    if (error) throw error;

    console.log("✅ OCR result saved in Supabase:", data);
    return res.json({ success: true, data });
  } catch (err) {
    console.error("🔴 Error saving OCR result:", err);
    res.status(500).json({ error: "Failed to save OCR result" });
  }
});


app.post("/analyze-bank-statement", async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: "User name is required." });

  try {
    // 1️⃣ Fetch latest statement text
    const { data, error } = await supabase
      .from("bank_statements")
      .select("extracted_text")
      .eq("user_name", name)
      .order("uploaded_at", { ascending: false })
      .limit(1);

    if (error) throw error;
    if (!data?.length)
      return res.status(404).json({ error: "No bank statement found." });

    const extractedText = data[0].extracted_text;
    console.log(`🔍 Analyzing bank statement for ${name}`);

    // 2️⃣ Use the new Responses API
    const result = await openai.responses.create({
      model: "gpt-5-mini",
      reasoning: { effort: "low" },
      text: { verbosity: "low" },
      input: `
You are a financial risk assessor. Analyze the provided **bank statement text** and assess the applicant using the criteria below:\n\n" +

"📌 **Decline Criteria:**\n" +

"1. **Overdrawn Balances (Severe Negative Funds)**\n" +
"   - Check the **balance column**.\n" +
"   - Decline if any balance is shown as more than **£100 overdrawn**, indicated by either:\n" +
"     • A **negative value less than -£100** (e.g. -£120), or\n" +
"     • A value over £100 that includes **'OD'** (e.g. 125.00 OD)\n" +
"     • **NEVER INCLUDE MONEY IN ANY SAVING POTS**\n" +

"2. **Gambling Transactions**\n" +
"   - Search for gambling-related keywords in transaction descriptions (see keyword list below).\n" +
"   - Match these transactions to the **'Amount'** or **'Money Out'** columns.\n" +
"   - If the **total gambling spend exceeds £200**, decline the application.\n" +
"   - Keywords include: Bet, Casino, Poker, Slot, Roulette, Blackjack, Sportsbet, Gamble, Bingo, Wager, Betslip, Jackpot, Odds, Betting, Bet365, Ladbrokes, William Hill, Coral, SkyBet, PokerStars, Paddy Power, 888 Casino, Betfair, Betway, Unibet, Bwin, SportsBetting.ag, Betfred, Grosvenor Casinos, PartyPoker, Spreadex, BetVictor, Betsson, BoyleSports, VBet, LeoVegas, Casino.com, NetBet, FortuneJack. [DO NOT list keywords in the response]\n\n" +

"3. **Returned Payments / Arrestments**\n" +
"   - Look for keywords such as **'Returned DD'**, **'Direct Debit Reversal'**, or **'Arrestment'**.\n" +
"   - If found, decline the application.\n\n" +

"📋 **Buy Now Pay Later (BNPL) Usage:**\n" +
"This does not result in a decline but should be **summarized**.\n" +
"Look for BNPL providers such as: Klarna, Clearpay, Laybuy, Zilch, Payl8r, DivideBuy, Snap Finance, PayPal Pay in 3, Flexifi, Humm, Openpay, Affirm, Sezzle, Zip, Afterpay. [DO NOT list keywords in the response]\n" +
"If found, include this summary:\n" +
"BNPL Summary: [List of BNPL transactions with total amount]\n\n" +

"📋 **Other Credit or Loan Repayments:**\n" +
"This also does not result in a decline but should be **summarized**.\n" +
"Look for transactions related to personal loans, credit cards, or finance providers.\n" +
"Include keywords or provider names such as: Capital One, Vanquis, Aqua, Barclaycard, MBNA, Tesco Bank, Sainsbury’s Bank, Likely Loans, Everyday Loans, Avant, Fund Ourselves, 118 118 Money, Drafty, Lending Stream, Bamboo Loans, Amigo Loans, TrustTwo, Oakam, Dot Dot Loans, SafetyNet, Zopa, Tappily, CashFloat, Sunny, MyJar, WageDay Advance, PayDay UK, Provident, Credit Spring, TotallyMoney, ClearScore, CashPlus, Loqbox, and any transaction including keywords like **‘credit’, ‘loan’, ‘finance’, ‘repayment’, ‘instalment’**, or **‘monthly payment’**. [DO NOT list keywords in the response]\n" +
"If found, include this summary:\n" +
"Credit/Loan Summary: [List of loan provider names with total amounts]\n\n" +

"📊 **Pay Likelihood Analysis:**\n" +
"This is not a decline factor but should be **included in the report** to assess affordability patterns.\n" +
"Analyze the bank statement to estimate the applicant’s ability to make a **£20 weekly repayment** reliably.\n" +
"Base your analysis on recurring income and outgoings patterns.\n" +
"Include the following:\n" +
"   - **Likelihood %** of successful repayment each week (e.g., 85%)\n" +
"   - **Best Day(s) of the Week** to collect payment (e.g., Friday)\n" +
"   - **Typical Income Days** (e.g., salary deposits, benefits, etc.)\n" +
"   - **Week-by-Week Trend Summary** indicating high or low balance periods\n" +
"   - Short explanation of the **customer’s affordability pattern**\n" +
"Keep this section brief but data-driven.\n\n" +

"✅ **Decision Format:**\n" +
"Decision MUST be first in the response and only show one decision either 'PASSED' or 'DECLINED'\n" +
"If any **decline criteria** are met:\n" +
"DECLINED - Reason: [Detailed reason(s) for decline]\n\n" +
"If **none** are met:\n" +
"PASSED - Reason: [Why the application passed]\n\n" +

"🧾 **Structured Summary (Output Format):**\n" +
"Please return your results in the following structured format and make the category headers BOLD for readability and do not include any <br> tags in the response, they are to show where breaks go:\n\n" +
"**The Decision:** [PASSED or DECLINED - Reason]\n<br>\n" +
"**Overdrawn Balances:** [Summary of findings]\n<br>\n" +
"**Gambling Transactions:** [Summary of findings]\n<br>\n" +
"**Returned Payments / Arrestments:** [Summary of findings]\n<br>\n" +
"**Buy Now Pay Later (BNPL) Usage:** [Summary of findings]\n<br>\n" +
"**Other Credit or Loan Repayment:** [Summary of findings]\n<br>\n" +
"**Pay Likelihood Analysis:** [Summary of findings]\n"


"Here is the bank statement text:\n" +
${extractedText}
      `,
      max_output_tokens: 15000,
    });

    console.log(`✅ GPT-5 Response for ${name}:`, result.output_text);
    res.json({ decision: result.output_text });
  } catch (error) {
    console.error("❌ Error analyzing bank statement:", error);
    res.status(500).json({ error: error.message });
  }
});


// ✅ Permanent on-demand version
app.post("/generate-download-url", async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: "Missing userId" });
  }

  const params = {
    Bucket: process.env.S3_BUCKET_NAME,
    Prefix: `bank-statements/${encodeURIComponent(userId)}/`,
  };

  try {
    // List all files in that user's folder
    const data = await s3.listObjectsV2(params).promise();
    const filtered = data.Contents.filter(obj => !obj.Key.endsWith("index.html"));
    if (!data.Contents || data.Contents.length === 0) {
      return res.status(404).json({ error: "No files found in this folder" });
    }

    // Create fresh signed URLs (valid for 1 hour each time it's viewed)
    const files = await Promise.all(
  data.Contents
    // 🔹 Filter out unwanted files (index.html, temp files, empty folders)
    .filter(obj => {
      const name = obj.Key.split("/").pop();
      if (!name) return false; // skip empty folder markers
      const lower = name.toLowerCase();
      return (
        !lower.endsWith("index.html") &&
        !lower.endsWith(".tmp") &&
        !lower.endsWith(".json")
      );
    })
    // 🔹 Generate fresh signed URLs only for valid files
    .map(async (obj) => {
      const url = s3.getSignedUrl("getObject", {
        Bucket: process.env.S3_BUCKET_NAME,
        Key: obj.Key,
        Expires: 3600, // 1 hour
      });

      return {
        name: obj.Key.split("/").pop(),
        url,
        size: obj.Size, // optional: file size in bytes
        lastModified: obj.LastModified, // optional: timestamp
      };
    })
);


    // Build HTML dynamically (no file uploaded back to S3)
    const html = `
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${userId.replace(/-/g, " ")} – Bank Statements</title>
    <style>
      body {
        font-family: "Segoe UI", Roboto, sans-serif;
        background: #f9fafb;
        color: #111827;
        margin: 0;
        padding: 40px;
      }
      .container {
        max-width: 700px;
        margin: auto;
        background: white;
        border-radius: 12px;
        padding: 30px;
        box-shadow: 0 4px 12px rgba(0,0,0,0.05);
      }
      h1 {
        color: #059669;
        font-size: 1.8rem;
        margin-bottom: 5px;
      }
      p.sub {
        color: #6b7280;
        margin-bottom: 20px;
        font-size: 0.9rem;
      }
      ul {
        list-style: none;
        padding: 0;
        margin: 0;
      }
      li {
        background: #f3f4f6;
        border-radius: 8px;
        margin-bottom: 10px;
        padding: 10px 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      a {
        text-decoration: none;
        color: white;
        background: #10b981;
        padding: 6px 12px;
        border-radius: 6px;
        font-size: 0.85rem;
        font-weight: 600;
      }
      a:hover {
        background: #059669;
      }
      footer {
        text-align: center;
        font-size: 0.8rem;
        color: #9ca3af;
        margin-top: 25px;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <h1>Diamond Finance – Bank Statements</h1>
      <p class="sub">Customer: ${userId.replace(/-/g, " ")}</p>
      <ul>
        ${files.map(f => `
          <li>
            <span>${f.name}</span>
            <a href="${f.url}" target="_blank">View</a>
          </li>
        `).join("")}
      </ul>
      <footer>
        Generated ${new Date().toLocaleString("en-GB")}
      </footer>
    </div>
  </body>
</html>
`;


    res.setHeader("Content-Type", "text/html");
    res.send(html);
  } catch (error) {
    console.error("❌ Error generating folder link:", error);
    res.status(500).json({ error: "Failed to generate folder pre-signed URL" });
  }
});







app.post("/generate-upload-url", async (req, res) => {
  const { fileName, fileType, userId } = req.body;

  if (!fileName || !fileType || !userId) {
      console.error("❌ Missing required fields: fileName, fileType, or userId");
      return res.status(400).json({ error: "Missing fileName, fileType, or userId" });
  }

  // ✅ Store files inside a user-specific folder
  const fileKey = `bank-statements/${encodeURIComponent(userId)}/${Date.now()}-${encodeURIComponent(fileName)}`;

  const params = {
      Bucket: process.env.S3_BUCKET_NAME,
      Key: fileKey,
      ContentType: fileType,
      Expires: 300 // 5-minute expiration
  };

  try {
      const uploadUrl = s3.getSignedUrl("putObject", params);
      console.log("✅ Upload URL Generated");

      res.json({ uploadUrl, fileKey });
  } catch (error) {
      console.error("❌ Error generating upload URL:", error);
      res.status(500).json({ error: "Failed to generate upload URL" });
  }
});


import fetch from "node-fetch";
import fs from "fs";

const METADEFENDER_API_KEY = "66042e4723b1af464b851f6005655c72"; // Replace with your actual API key

async function scanFileWithMetadefender(filePath) {
    try {
        const fileStream = fs.createReadStream(filePath);

        // ✅ Step 1: Upload File to Metadefender
        const response = await fetch("https://api.metadefender.com/v4/file", {
            method: "POST",
            headers: {
                "apikey": METADEFENDER_API_KEY, // ✅ Fixed Syntax Error
                "Content-Type": "application/octet-stream"
            },
            body: fileStream
        });

        const data = await response.json();

        if (!data.data_id) {
            console.error("❌ Error: No data_id returned from Metadefender", data);
            return { success: false, error: "Failed to get scan ID", details: data };
        }

        console.log(`🔍 Scan started for: ${filePath}`);
        console.log(`📌 Metadefender Scan ID: ${data.data_id}`);

        // ✅ Step 2: Wait for Scan to Complete
        const scanResult = await waitForMetadefenderScan(data.data_id);

        if (scanResult.success) {
            console.log("✅ File is clean!");
            return { success: true };
        } else {
            console.error("❌ File is infected!", scanResult.details);
            return { success: false, error: "File is infected!", details: scanResult.details };
        }

    } catch (error) {
        console.error("❌ Error scanning file with Metadefender:", error);
        return { success: false, error: "Error scanning file.", details: error };
    }
}

// ✅ Function to Poll Metadefender Until Scan is Complete
async function waitForMetadefenderScan(scanId) {
    const scanUrl = `https://api.metadefender.com/v4/file/${scanId}`;

    let attempts = 0;
    const maxAttempts = 20; // ⏳ Wait up to 60 sec (20 attempts * 3 sec)

    while (attempts < maxAttempts) {
        console.log(`⏳ Checking scan status (${attempts + 1}/${maxAttempts})...`);

        const response = await fetch(scanUrl, {
            method: "GET",
            headers: { "apikey": METADEFENDER_API_KEY }
        });

        const data = await response.json();

        if (data.scan_results && data.scan_results.scan_all_result_a) {
            if (data.scan_results.scan_all_result_a === "No Threat Detected") {
                return { success: true };
            } else if (data.scan_results.scan_all_result_a !== "In Progress") {
                return { success: false, details: data };
            }
        }

        // ⏳ Wait before retrying (3 sec delay)
        await new Promise(resolve => setTimeout(resolve, 3000));
        attempts++;
    }

    return { success: false, error: "Scan timeout: No result received." };
}

app.post("/scan-and-upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
      console.error("❌ No file uploaded in request.");
      return res.status(400).json({ error: "No file uploaded." });
  }

  const filePath = req.file.path;
  console.log("🔍 Scanning file:", filePath);

  try {
      const scanResult = await scanFileWithMetadefender(filePath);

      if (!scanResult.success) {
          console.error("❌ Virus detected or scanning failed!", scanResult);

          try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
                console.log("🗑️ Temp file deleted successfully.");
            }
        } catch (err) {
            console.warn("⚠️ Warning: File deletion error:", err);
        }
        

          return res.status(400).json(scanResult); // Block upload
      }

      console.log("✅ File is clean. Proceeding with upload...");

      // ✅ Check if file exists before deletion
      if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          console.log("🗑️ Temp file deleted successfully.");
      } else {
          console.warn("⚠️ Warning: File not found, skipping deletion:", filePath);
      }

      res.json({ success: true });

  } catch (error) {
      console.error("❌ Error processing file:", error);
      res.status(500).json({ error: "Internal server error." });
  }
});


app.post("/user-left", (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    console.warn("⚠️ /user-left called with no userId.");
    return res.status(400).json({ error: "Missing userId" });
  }

  // ✅ Log to console only
  console.log(`📌 User ${userId} left the chatbot at ${new Date().toISOString()}`);

  // ✅ Send response
  res.json({ success: true, message: "User exit logged (console only)." });
});




app.post("/ocr-image", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: "No file uploaded." });
  }

  try {
    console.log("📤 Sending image to OCR.Space:", req.file.path);

    const formData = new FormData();
    formData.append("file", fs.createReadStream(req.file.path));
    formData.append("filetype", path.extname(req.file.originalname).substring(1)); // e.g., "jpg", "png", "pdf"
    formData.append("language", "eng");
    formData.append("isOverlayRequired", "false");

    const ocrSpaceApiKey = process.env.OCR_SPACE_API_KEY || "your_api_key_here";

    const response = await axios.post("https://apipro1.ocr.space/parse/image", formData, {
      headers: {
        ...formData.getHeaders(),
        apikey: ocrSpaceApiKey
      }
    });

    fs.unlinkSync(req.file.path);

    const parsedResult = response.data?.ParsedResults?.[0]?.ParsedText;
    if (parsedResult) {
      res.json({ success: true, text: parsedResult.trim() });
    } else {
      console.error("🛑 OCR.Space failed response:", response.data);
      res.status(500).json({ success: false, error: "OCR failed or returned no text." });
    }

  } catch (err) {
    console.error("🛑 Error during OCR.Space request:", err);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ success: false, error: "Failed to extract text." });
  }
});


// ----- Start the Server -----
const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  console.log(`🚀 BankBot server running on port ${PORT}`);
  await connectToDatabase();
});



