import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import https from "https";
import http from "http";
import iconv from "iconv-lite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: false, // Disable keepAlive to prevent socket reuse issues with some servers
});

const httpAgent = new http.Agent({
  keepAlive: false,
});

// Robust decoding for Korean filenames
function decodeKorean(str: string): string {
  if (!str) return str;
  
  // 0. Handle RFC 2047 (e.g., =?UTF-8?B?...?= or =?EUC-KR?B?...?=)
  if (str.startsWith('=?') && str.endsWith('?=') && str.includes('?')) {
    try {
      const parts = str.split('?');
      if (parts.length >= 4) {
        const encoding = parts[1].toUpperCase();
        const type = parts[2].toUpperCase();
        const data = parts[3];
        
        let binary: Buffer;
        if (type === 'B') {
          binary = Buffer.from(data, 'base64');
        } else if (type === 'Q') {
          // Simple Quoted-Printable decoding
          const qp = data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          binary = Buffer.from(qp, 'binary');
        } else {
          binary = Buffer.from(data);
        }
        
        const decoded = iconv.decode(binary, encoding === 'EUC-KR' ? 'cp949' : encoding);
        if (/[가-힣]/.test(decoded)) return decoded;
      }
    } catch (e) {}
  }

  // 1. If it contains % (URL encoded), try to decode it first
  if (str.includes('%')) {
    try {
      const uriDecoded = decodeURIComponent(str);
      if (/[가-힣]/.test(uriDecoded)) return uriDecoded;
    } catch (e) {}
  }

  try {
    // 2. Try to treat as binary and decode as CP949
    const binary = Buffer.from(str, 'binary');
    const decoded = iconv.decode(binary, 'cp949');
    if (/[가-힣]/.test(decoded)) return decoded;
    
    // 3. Try to treat as UTF-8 but misinterpreted as Latin1
    const utf8 = iconv.decode(binary, 'utf-8');
    if (/[가-힣]/.test(utf8)) return utf8;
  } catch (e) {}
  
  return str;
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  // API route to fetch PDF and bypass CORS
  app.get("/api/proxy-pdf", async (req, res) => {
    let pdfUrl = req.query.url as string;
    if (!pdfUrl) {
      return res.status(400).json({ error: "URL is required" });
    }

    pdfUrl = pdfUrl.trim();

    const source = axios.CancelToken.source();
    req.on('close', () => {
      source.cancel('Client closed connection');
    });

    try {
      let origin = "";
      let host = "";
      try {
        const urlObj = new URL(pdfUrl);
        origin = urlObj.origin;
        host = urlObj.host;
      } catch (e) {}

      const response = await axios.get(pdfUrl, {
        responseType: 'stream',
        timeout: 300000, // Increased to 300s (5 mins)
        httpsAgent: httpsAgent,
        httpAgent: httpAgent,
        cancelToken: source.token,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
          "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
          "Cache-Control": "no-cache",
          "Pragma": "no-cache",
          "Connection": "close",
          "Upgrade-Insecure-Requests": "1",
          ...(host ? { "Host": host } : {}),
          ...(origin ? { "Referer": origin } : {})
        },
        validateStatus: () => true
      });
      
      if (response.status !== 200) {
        console.error(`Proxy fetch failed with status ${response.status} for URL: ${pdfUrl}`);
        return res.status(response.status).json({ error: `Failed to fetch PDF: ${response.statusText} (${response.status})` });
      }

      // Forward relevant headers
      const headersToForward = ['content-type', 'content-disposition', 'content-length', 'cache-control'];
      headersToForward.forEach(header => {
        if (response.headers[header]) {
          res.setHeader(header, response.headers[header]);
        }
      });

      // Special handling for filename decoding
      const contentDisposition = response.headers["content-disposition"];
      if (contentDisposition) {
        try {
          let rawFilename = "";
          
          // Try filename* (RFC 6266)
          const starMatch = contentDisposition.match(/filename\*=['"]?(?:UTF-8|EUC-KR)''([^;'"\n]*)['"]?/i);
          if (starMatch && starMatch[1]) {
            rawFilename = starMatch[1];
          } else {
            // Try regular filename
            const regMatch = contentDisposition.match(/filename=['"]?([^;'"\n]*)['"]?/i);
            if (regMatch && regMatch[1]) {
              rawFilename = regMatch[1];
            }
          }

          if (rawFilename) {
            let decoded = decodeKorean(rawFilename);
            if (/[가-힣]/.test(decoded)) {
              res.setHeader("X-Filename-Decoded", encodeURIComponent(decoded));
            }
          }
        } catch (e) {
          console.error("Error decoding filename in proxy:", e);
        }
      }

      // Use pipeline for robust streaming
      const { pipeline } = await import("stream/promises");
      
      try {
        await pipeline(response.data, res);
      } catch (err: any) {
        if (err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
          console.log('Stream closed prematurely by client or server');
        } else {
          console.error('Pipeline error:', err);
        }
        // If headers are already sent, we can't send a 500. 
        // The client will see a truncated file.
      }

    } catch (error: any) {
      if (axios.isCancel(error)) {
        console.log('Proxy request cancelled:', error.message);
        return;
      }
      console.error("Proxy error:", error);
      const message = error.response?.data?.error || error.message || String(error);
      if (!res.headersSent) {
        res.status(500).json({ error: `Proxy error: ${message}. Please check if the URL is accessible.` });
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
}

startServer();
