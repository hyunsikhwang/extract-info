import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { PDFDocument } from 'pdf-lib';
import JSZip from 'jszip';
import iconv from 'iconv-lite';
import { Buffer } from 'buffer';

// Set worker source for pdfjs-dist
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

/**
 * Robustly decodes strings or bytes that might be incorrectly encoded.
 * Tries multiple common Korean encodings and selects the one that produces the most Korean characters.
 */
function tryDecode(input: string | Uint8Array | any): string {
  if (!input) return "";
  
  let bytes: Buffer;
  let originalStr = "";

  if (typeof input === 'string') {
    originalStr = input;
    // If it's already clean ASCII, return as is
    if (!/[^\x00-\x7F]/.test(input)) return input;
    // Most Mojibake occurs when bytes are read as Latin1
    bytes = Buffer.from(input, 'binary');
  } else if (input instanceof Uint8Array) {
    bytes = Buffer.from(input);
  } else if (Array.isArray(input)) {
    bytes = Buffer.from(input);
  } else {
    try {
      bytes = Buffer.from(input);
    } catch (e) {
      return String(input);
    }
  }

  const encodings = ['cp949', 'euc-kr', 'utf-8', 'utf-16le', 'utf-16be', 'iso-8859-1'];
  const keywords = ['경영공시', '정기공시', '공시', '결산', '사업보고서', '보험', 'disclosure', '현황', '삼성화재', '현대해상', 'DB손해보험', 'KB손해보험', '메리츠화재'];
  
  let bestText = originalStr || "";
  let bestScore = -1;

  const scoreText = (text: string) => {
    if (!text) return -1;
    let score = 0;
    // Count Korean characters
    const koreanMatch = text.match(/[가-힣]/g);
    score += (koreanMatch ? koreanMatch.length : 0) * 20; // Increased weight
    
    // Huge bonus for keywords
    for (const kw of keywords) {
      if (text.toLowerCase().includes(kw.toLowerCase())) {
        score += 2000; // Increased weight
      }
    }
    
    // Penalty for too many control characters or replacement characters
    const badChars = text.match(/[\u0000-\u001F\u007F-\u009F\uFFFD]/g);
    score -= (badChars ? badChars.length : 0) * 50;
    
    // Penalty for very short strings if they have bad chars
    if (text.length < 3 && badChars) score -= 200;

    // Bonus for common Korean sentence structures or markers
    if (text.includes('의 현황') || text.includes('관련 현황') || text.includes('보고서')) score += 500;

    return score;
  };

  // Strategy -1: RFC 2047 (B/Q encoding)
  if (typeof input === 'string' && input.startsWith('=?') && input.endsWith('?=') && input.includes('?')) {
    try {
      const parts = input.split('?');
      if (parts.length >= 4) {
        const encoding = parts[1].toUpperCase();
        const type = parts[2].toUpperCase();
        const data = parts[3];
        
        let binary: Buffer;
        if (type === 'B') {
          binary = Buffer.from(data, 'base64');
        } else if (type === 'Q') {
          const qp = data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
          binary = Buffer.from(qp, 'binary');
        } else {
          binary = Buffer.from(data);
        }
        
        const decoded = iconv.decode(binary, encoding === 'EUC-KR' ? 'cp949' : encoding);
        const score = scoreText(decoded);
        if (score > bestScore) {
          bestText = decoded;
          bestScore = score;
        }
      }
    } catch (e) {}
  }

  // Strategy 0: URL Decoding (if string)
  if (typeof input === 'string' && input.includes('%')) {
    try {
      const uriDecoded = decodeURIComponent(input);
      const score = scoreText(uriDecoded);
      if (score > bestScore) {
        bestText = uriDecoded;
        bestScore = score;
      }
    } catch (e) {}
  }

  // Strategy 1: Decode from bytes using iconv-lite
  for (const encoding of encodings) {
    try {
      const decoded = iconv.decode(bytes, encoding);
      const score = scoreText(decoded);
      if (score > bestScore) {
        bestText = decoded;
        bestScore = score;
      }
    } catch (e) {}
  }

  // Strategy 2: If input was string, try UTF-8 Mojibake Recovery
  if (typeof input === 'string') {
    try {
      const utf8Bytes = Buffer.from(input, 'utf8');
      for (const encoding of encodings) {
        if (encoding === 'utf-8') continue;
        try {
          const decoded = iconv.decode(utf8Bytes, encoding);
          const score = scoreText(decoded);
          if (score > bestScore) {
            bestText = decoded;
            bestScore = score;
          }
        } catch (e) {}
      }
    } catch (e) {}
  }

  // Strategy 3: Specific Mojibake Mappings (Extended)
  try {
    const manualMap: Record<number, number> = {
      0x11A: 0xC1, // Ě -> 제 (1st byte)
      0x238: 0xA6, // ȸ -> 제 (2nd byte)
      0x00C0: 0xB0, // À -> 경 (1st byte)
      0x00E6: 0xE5, // æ -> 경 (2nd byte)
      0x00C1: 0xB0, // Á -> 경 (alternative)
      0x00D1: 0xB0, // Ñ -> 경 (alternative)
    };
    
    const customBytes = Buffer.from(Array.from(bytes).map(b => manualMap[b] || b));
    const decoded = iconv.decode(customBytes, 'cp949');
    const score = scoreText(decoded);
    if (score > bestScore) {
      bestText = decoded;
      bestScore = score;
    }
  } catch (e) {}
  
  if (bestScore >= 0) {
    return bestText.trim();
  }

  return (typeof input === 'string' ? input : "").replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
}

export interface TableRow {
  category: string;
  before: string;
  after: string;
}

export interface ComparisonTableRow {
  year: string;
  expected: string;
  actual: string;
  difference: string;
}

export interface ExtractedTable<T> {
  data: T[];
  page: number | null;
}

export interface ExtractedData {
  companyName: string | null;
  fileName: string;
  fullText: string;
  table1: ExtractedTable<TableRow>;
  table2: ExtractedTable<TableRow>;
  table3: ExtractedTable<TableRow>;
  table4: ExtractedTable<ComparisonTableRow>;
  table5: ExtractedTable<any>;
  originalBuffer: ArrayBuffer;
  numPages: number;
  error?: string;
  url?: string;
  geminiData?: any;
  mergedBuffer?: ArrayBuffer;
  id: string;
}

export async function extractTextFromUrl(url: string): Promise<ExtractedData> {
  const proxyUrl = `/api/proxy-pdf?url=${encodeURIComponent(url)}`;
  const response = await fetch(proxyUrl);
  
  if (!response.ok) {
    let errorMessage = `Failed to fetch file from proxy (Status: ${response.status})`;
    try {
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const errorData = await response.json();
        errorMessage = errorData.error || errorMessage;
      } else {
        const textError = await response.text();
        if (textError && textError.length < 200) {
          errorMessage = textError;
        }
      }
    } catch (e) {
      // Fallback to default message
    }
    throw new Error(errorMessage);
  }
  
  // Try to extract filename from headers
  let fileName = 'document.pdf';
  const decodedHeader = response.headers.get('x-filename-decoded');
  if (decodedHeader) {
    try {
      fileName = decodeURIComponent(decodedHeader);
    } catch (e) {}
  } else {
    const contentDisposition = response.headers.get('content-disposition');
    if (contentDisposition) {
      let rawFilename = "";
      // Support both filename and filename* (RFC 5987)
      const starMatch = contentDisposition.match(/filename\*=['"]?(?:UTF-8|EUC-KR)''([^;'"\n]*)['"]?/i);
      if (starMatch && starMatch[1]) {
        rawFilename = starMatch[1];
      } else {
        const regMatch = contentDisposition.match(/filename=['"]?([^;'"\n]*)['"]?/i);
        if (regMatch && regMatch[1]) {
          rawFilename = regMatch[1];
        }
      }
      
      if (rawFilename) {
        fileName = tryDecode(rawFilename);
      }
    } else {
      // Fallback to URL basename
      try {
        const urlObj = new URL(url);
        const pathname = urlObj.pathname;
        const base = pathname.substring(pathname.lastIndexOf('/') + 1);
        if (base && base.toLowerCase().endsWith('.pdf')) {
          fileName = tryDecode(base);
        }
      } catch (e) {}
    }
  }

  const contentLength = response.headers.get('content-length');
  const arrayBuffer = await response.arrayBuffer();
  
  // Verify download completeness if content-length is available
  if (contentLength && arrayBuffer.byteLength < parseInt(contentLength, 10)) {
    throw new Error(`파일 다운로드가 중단되었습니다. (수신: ${arrayBuffer.byteLength} bytes, 기대: ${contentLength} bytes)`);
  }
  
  try {
    // Check if it's a ZIP file (starts with PK)
    const uint8 = new Uint8Array(arrayBuffer.slice(0, 2));
    const signature = String.fromCharCode(...uint8);
    
    if (signature === "PK") {
      const zip = new JSZip();
      const zipContent = await zip.loadAsync(arrayBuffer, {
        decodeFileName: (bytes) => tryDecode(bytes)
      });
      
      const allFiles = Object.keys(zipContent.files);
      console.log("[ZIP] Files found in archive:", allFiles);

      // 1. Get all PDF files with their metadata
      const pdfCandidates = await Promise.all(
        allFiles
          .filter(name => name.toLowerCase().endsWith('.pdf') && !zipContent.files[name].dir)
          .map(async name => {
            const fileData = zipContent.files[name];
            const content = await fileData.async('arraybuffer');
            // Filename is already decoded by JSZip using our tryDecode logic
            return { 
              name, 
              size: content.byteLength,
              content
            };
          })
      );

      if (pdfCandidates.length === 0) {
        throw new Error('ZIP 파일 내에 PDF 파일이 존재하지 않습니다.');
      }

      // Sort by size descending
      pdfCandidates.sort((a, b) => b.size - a.size);

      console.log("[ZIP] PDF Candidates (Sorted by Size):", pdfCandidates.map(p => ({ 
        name: p.name, 
        size: `${(p.size / 1024).toFixed(2)} KB` 
      })));

      // 2. Selection Logic: Strict "경영공시" Filename Priority
      console.log("[ZIP] Searching for disclosure PDF. Priority: Filename containing '경영공시'");

      // First Priority: Any file with "경영공시" in the name
      const disclosureNamedFiles = pdfCandidates.filter(p => p.name.toLowerCase().includes('경영공시'));
      
      let targetPdf = null;

      if (disclosureNamedFiles.length > 0) {
        // If multiple files have "경영공시", pick the largest one (usually the main report)
        disclosureNamedFiles.sort((a, b) => b.size - a.size);
        targetPdf = disclosureNamedFiles[0];
        console.log(`[ZIP] Found '경영공시' in filename. Selecting largest: ${targetPdf.name}`);
      } else {
        // Second Priority: Scoring system for other keywords
        console.log("[ZIP] '경영공시' not found in filenames. Using scoring system for other keywords...");
        
        const scoreFilename = (name: string) => {
          const lower = name.toLowerCase();
          let score = 0;

          // Positive keywords
          if (lower.includes('정기공시')) score += 900;
          if (lower.includes('사업보고서')) score += 800;
          if (lower.includes('분기보고서')) score += 700;
          if (lower.includes('반기보고서')) score += 700;
          if (lower.includes('공시')) score += 500;
          if (lower.includes('결산')) score += 300;
          if (lower.includes('현황')) score += 200;
          if (lower.includes('disclosure')) score += 200;

          // Negative keywords
          if (lower.includes('검토보고서')) score -= 2000;
          if (lower.includes('감사보고서')) score -= 2000;
          if (lower.includes('요약')) score -= 500;
          if (lower.includes('영문')) score -= 800;
          if (lower.includes('english')) score -= 800;
          if (lower.includes('별도')) score -= 100;

          return score;
        };

        const scoredCandidates = pdfCandidates.map(p => ({
          ...p,
          filenameScore: scoreFilename(p.name)
        }));

        scoredCandidates.sort((a, b) => {
          if (b.filenameScore !== a.filenameScore) {
            return b.filenameScore - a.filenameScore;
          }
          return b.size - a.size;
        });

        if (scoredCandidates[0]?.filenameScore > 0) {
          targetPdf = scoredCandidates[0];
          console.log(`[ZIP] Selected best matching file by score: ${targetPdf.name} (Score: ${targetPdf.filenameScore})`);
        }
      }

      if (!targetPdf) {
        // Stage B: Check content of top candidates (up to 15) if filename check failed
        console.log("[ZIP] No suitable filename found. Checking content of top 15 candidates...");
        for (let i = 0; i < Math.min(15, pdfCandidates.length); i++) {
          const candidate = pdfCandidates[i];
          try {
            const loadingTask = pdfjsLib.getDocument({ data: candidate.content.slice(0) });
            const pdf = await loadingTask.promise;
            const firstPage = await pdf.getPage(1);
            const textContent = await firstPage.getTextContent();
            const pageText = textContent.items.map((item: any) => item.str).join('');
            
            // Check for keywords in the actual content (first page)
            const lowerPageText = pageText.toLowerCase();
            if (lowerPageText.includes('경영공시') || 
                lowerPageText.includes('정기공시') || 
                lowerPageText.includes('공시') || 
                lowerPageText.includes('보험회사') || 
                lowerPageText.includes('결산') ||
                lowerPageText.includes('사업보고서')) {
              console.log(`[ZIP] Found disclosure keyword in content of candidate #${i+1}: ${candidate.name}.`);
              targetPdf = candidate;
              break;
            }
          } catch (err) {
            console.warn(`[ZIP] Error checking content for candidate #${i+1}:`, err);
          }
        }
      }

      // FINAL FALLBACK: If still no disclosure document found, take the largest PDF as a last resort
      if (!targetPdf && pdfCandidates.length > 0) {
        console.warn("[ZIP] No disclosure keywords found. Falling back to the largest PDF in the archive.");
        targetPdf = pdfCandidates[0];
      }

      if (!targetPdf) {
        console.error("[ZIP] Critical Error: No PDF files found in the archive.");
        throw new Error('ZIP 파일 내에서 분석 가능한 PDF 문서를 찾을 수 없습니다.');
      }

      const displayLabel = targetPdf.name.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim() || "경영공시.pdf";
      console.log(`[ZIP] Final Selection: ${displayLabel} (Size: ${(targetPdf.size / 1024).toFixed(2)} KB)`);
      
      const file = new File([targetPdf.content], displayLabel, { type: 'application/pdf' });
      return extractTextFromPdf(file);
    }
    
    const file = new File([arrayBuffer], fileName, { type: 'application/pdf' });
    return extractTextFromPdf(file);
  } catch (err) {
    console.error('Extraction failed but buffer was retrieved:', err);
    return {
      companyName: null,
      fileName: fileName,
      fullText: '',
      table1: { data: [], page: null },
      table2: { data: [], page: null },
      table3: { data: [], page: null },
      table4: { data: [], page: null },
      table5: { data: [], page: null },
      originalBuffer: arrayBuffer,
      numPages: 0,
      error: err instanceof Error ? err.message : String(err),
      id: Math.random().toString(36).substring(2, 11)
    };
  }
}

export async function extractTextFromPdf(file: File): Promise<ExtractedData> {
  const arrayBuffer = await file.arrayBuffer();
  const fileName = file.name;
  
  // Basic validation before passing to pdfjs
  if (arrayBuffer.byteLength < 10) {
    throw new Error('The file is too small to be a valid PDF.');
  }
  
  const uint8 = new Uint8Array(arrayBuffer.slice(0, 5));
  const signature = String.fromCharCode(...uint8);
  if (signature !== "%PDF-") {
    throw new Error('Invalid PDF structure: The file does not start with the expected PDF signature.');
  }

  // Create a copy for pdfjsLib because it might detach the buffer
  const pdfjsBuffer = arrayBuffer.slice(0);
  
  try {
    const loadingTask = pdfjsLib.getDocument({ 
      data: pdfjsBuffer,
      // Some PDFs might have minor issues that can be ignored
      stopAtErrors: false,
    });
    const pdf = await loadingTask.promise;
    
    let fullText = '';
    const pageTexts: string[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      try {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items.map((item: any) => item.str).join(' ');
        fullText += pageText + '\n\n';
        pageTexts.push(pageText);
      } catch (pageErr) {
        console.warn(`Failed to extract text from page ${i}:`, pageErr);
        pageTexts.push(""); // Push empty string to keep page indexing correct
      }
    }

    const table1 = parseTableSolvencyTotal(pageTexts);
    const table2 = parseTableSolvencyCommon(pageTexts);
    const table3 = parseTableSolvencySelective(pageTexts);
    const table4 = parseTableLossRatio(pageTexts);
    const table5 = parseTableRiskPremium(pageTexts);
    const companyName = extractCompanyName(pageTexts);

    return {
      companyName,
      fileName,
      fullText,
      table1,
      table2,
      table3,
      table4,
      table5,
      originalBuffer: arrayBuffer,
      numPages: pdf.numPages,
      id: Math.random().toString(36).substring(2, 11)
    };
  } catch (err) {
    console.error('PDF analysis failed:', err);
    let errorMessage = `PDF 분석 실패: ${err instanceof Error ? err.message : '알 수 없는 오류'}`;
    if (err instanceof Error && err.message.includes('Password')) {
      errorMessage = '이 PDF는 비밀번호로 보호되어 있어 처리할 수 없습니다.';
    }
    
    return {
      companyName: null,
      fileName,
      fullText: '',
      table1: { data: [], page: null },
      table2: { data: [], page: null },
      table3: { data: [], page: null },
      table4: { data: [], page: null },
      table5: { data: [], page: null },
      originalBuffer: arrayBuffer,
      numPages: 0,
      error: errorMessage,
      id: Math.random().toString(36).substring(2, 11)
    };
  }
}

function extractCompanyName(pageTexts: string[]): string | null {
  if (pageTexts.length === 0) return null;
  
  // Look at the first page
  const firstPage = pageTexts[0].replace(/\s+/g, ' ');
  
  // Pattern: {CompanyName} 의 현황
  // We look for the marker "의 현황" and take the word immediately preceding it
  const marker = "의 현황";
  const index = firstPage.indexOf(marker);
  
  if (index !== -1) {
    const textBefore = firstPage.substring(0, index).trim();
    const words = textBefore.split(' ');
    if (words.length > 0) {
      return words[words.length - 1];
    }
  }
  
  return null;
}

export async function slicePdfPage(arrayBuffer: ArrayBuffer, startPage: number, endPage: number): Promise<Uint8Array> {
  // Use a slice to avoid detaching the original buffer if load() performs any transfers
  const bufferCopy = arrayBuffer.slice(0);
  const pdfDoc = await PDFDocument.load(bufferCopy);
  const newPdf = await PDFDocument.create();
  
  const totalPages = pdfDoc.getPageCount();
  const pagesToCopy = [];
  
  // startPage and endPage are 1-indexed
  for (let i = startPage; i <= endPage; i++) {
    if (i >= 1 && i <= totalPages) {
      pagesToCopy.push(i - 1);
    }
  }
  
  if (pagesToCopy.length === 0) {
    throw new Error('Invalid page range');
  }

  const copiedPages = await newPdf.copyPages(pdfDoc, pagesToCopy);
  copiedPages.forEach(page => newPdf.addPage(page));
  
  return await newPdf.save();
}

export async function mergePdfPages(arrayBuffer: ArrayBuffer, pageNumbers: number[]): Promise<Uint8Array> {
  const bufferCopy = arrayBuffer.slice(0);
  const pdfDoc = await PDFDocument.load(bufferCopy);
  const newPdf = await PDFDocument.create();
  
  const totalPages = pdfDoc.getPageCount();
  const pagesToCopy: number[] = [];
  
  // pageNumbers are 1-indexed
  for (const pageNum of pageNumbers) {
    if (pageNum >= 1 && pageNum <= totalPages) {
      pagesToCopy.push(pageNum - 1);
    }
  }
  
  if (pagesToCopy.length === 0) {
    throw new Error('No valid pages to merge');
  }

  const copiedPages = await newPdf.copyPages(pdfDoc, pagesToCopy);
  copiedPages.forEach(page => newPdf.addPage(page));
  
  return await newPdf.save();
}

function parseTableSolvencyTotal(pageTexts: string[]): ExtractedTable<TableRow> {
  // Look for "지급여력비율 총괄"
  const keywords = ["지급여력비율", "총괄"];
  let foundPage = -1;
  let subText = "";

  const strip = (s: string) => s.replace(/\s+/g, '');

  for (let i = 0; i < pageTexts.length; i++) {
    const strippedPage = strip(pageTexts[i]);
    
    let lastIndex = -1;
    let allFoundInOrder = true;
    for (const kw of keywords) {
      const index = strippedPage.indexOf(strip(kw), lastIndex + 1);
      if (index === -1) {
        allFoundInOrder = false;
        break;
      }
      lastIndex = index;
    }
    
    if (allFoundInOrder) {
      foundPage = i + 1;
      subText = pageTexts[i] + (pageTexts[i+1] || "");
      break;
    }
  }

  if (foundPage === -1) return { data: [], page: null };
  
  const rowCategories = [
    "지급여력비율",
    "지급여력금액",
    "지급여력기준금액"
  ];

  return {
    data: extractRows(subText, rowCategories),
    page: foundPage
  };
}

function parseTableSolvencyCommon(pageTexts: string[]): ExtractedTable<TableRow> {
  // Look for "공통적용 경과조치 관련"
  const keywords = ["공통적용", "경과조치", "관련"];
  let foundPage = -1;
  let subText = "";

  // Helper to remove all whitespace for robust matching
  const strip = (s: string) => s.replace(/\s+/g, '');

  for (let i = 0; i < pageTexts.length; i++) {
    const strippedPage = strip(pageTexts[i]);
    
    // Check if all keywords exist in order within the stripped text
    let lastIndex = -1;
    let allFoundInOrder = true;
    for (const kw of keywords) {
      const index = strippedPage.indexOf(strip(kw), lastIndex + 1);
      if (index === -1) {
        allFoundInOrder = false;
        break;
      }
      lastIndex = index;
    }
    
    if (allFoundInOrder) {
      foundPage = i + 1;
      // Combine current page and next page to ensure we don't miss rows split across pages
      subText = pageTexts[i] + (pageTexts[i+1] || "");
      break;
    }
  }

  if (foundPage === -1) {
    return { data: [], page: null };
  }
  
  // Define expected rows for Table 2 (Common)
  const rowCategories = [
    "지급여력비율 (%)",
    "지급여력금액",
    "기본자본",
    "보완자본",
    "지급여력기준금액"
  ];

  return {
    data: extractRows(subText, rowCategories),
    page: foundPage
  };
}

function parseTableSolvencySelective(pageTexts: string[]): ExtractedTable<TableRow> {
  // Look for "자본감소분 경과조치"
  const keywords = ["자본감소분", "경과조치"];
  let foundPage = -1;
  let subText = "";

  // Helper to remove all whitespace for robust matching
  const strip = (s: string) => s.replace(/\s+/g, '');

  for (let i = 0; i < pageTexts.length; i++) {
    const strippedPage = strip(pageTexts[i]);
    
    // Check if all keywords exist in order within the stripped text
    let lastIndex = -1;
    let allFoundInOrder = true;
    for (const kw of keywords) {
      const index = strippedPage.indexOf(strip(kw), lastIndex + 1);
      if (index === -1) {
        allFoundInOrder = false;
        break;
      }
      lastIndex = index;
    }
    
    if (allFoundInOrder) {
      foundPage = i + 1;
      subText = pageTexts[i] + (pageTexts[i+1] || "");
      break;
    }
  }

  if (foundPage === -1) return { data: [], page: null };

  // Define expected rows for Table 3 (Selective)
  const rowCategories = [
    "지급여력비율 (%)",
    "지급여력금액",
    "기본자본",
    "보완자본",
    "자본감소분 경과조치 적용금액",
    "지급여력기준금액"
  ];

  const rows = extractRows(subText, rowCategories);
  
  // Check if "자본감소분 경과조치 적용금액" exists in the extracted rows
  const hasAppliedAmount = rows.some(row => row.category === "자본감소분 경과조치 적용금액");
  
  if (!hasAppliedAmount) {
    return { data: [], page: null };
  }

  return { data: rows, page: foundPage };
}

function parseTableLossRatio(pageTexts: string[]): ExtractedTable<ComparisonTableRow> {
  // Use more flexible markers to handle potential numbering or spacing issues
  const sectionMarker = "보험계약부채 및 가정 관련 현황";
  const subSectionMarker = "최적가정";
  const tableMarker = "보험금 예실차비율";

  let foundPage = -1;
  let targetText = "";

  // Helper to remove all whitespace for robust matching
  const strip = (s: string) => s.replace(/\s+/g, '');

  const strippedSectionMarker = strip(sectionMarker);
  const strippedSubSectionMarker = strip(subSectionMarker);
  const strippedTableMarker = strip(tableMarker);

  // 1. Find the section page
  let sectionPageIndex = -1;
  for (let i = 0; i < pageTexts.length; i++) {
    if (strip(pageTexts[i]).includes(strippedSectionMarker)) {
      sectionPageIndex = i;
      break;
    }
  }

  if (sectionPageIndex === -1) {
    sectionPageIndex = 0; 
  }

  // 2. Search for the table marker from the section page onwards
  for (let i = sectionPageIndex; i < pageTexts.length; i++) {
    const strippedPage = strip(pageTexts[i]);
    if (strippedPage.includes(strippedTableMarker)) {
      // Check if subSectionMarker exists before the table marker
      const combinedFromSection = pageTexts.slice(sectionPageIndex, i + 1).map(strip).join('');
      const tablePos = combinedFromSection.indexOf(strippedTableMarker);
      const textBeforeTable = combinedFromSection.substring(0, tablePos);
      
      if (textBeforeTable.includes(strippedSubSectionMarker) || sectionPageIndex > 0) {
        foundPage = i + 1;
        // For extraction, we use the space-normalized text
        targetText = pageTexts[i].replace(/\s+/g, ' ') + " " + (pageTexts[i + 1]?.replace(/\s+/g, ' ') || "");
        break;
      }
    }
  }

  if (foundPage === -1) return { data: [], page: null };

  // For finding values, we use the space-normalized text
  const normalizedTableMarker = tableMarker.replace(/\s+/g, ' ');
  const tableMarkerIndex = targetText.indexOf(tableMarker) !== -1 ? targetText.indexOf(tableMarker) : targetText.indexOf(normalizedTableMarker);
  
  // If still not found by exact match, find it by stripped match in normalized text
  let finalStartIndex = tableMarkerIndex;
  if (finalStartIndex === -1) {
    // This is a fallback to find the position in targetText that matches strippedTableMarker
    // (Though usually targetText will have the spaces)
    finalStartIndex = 0; // Default to start if we can't find exact index
  }

  const subText = targetText.substring(finalStartIndex, finalStartIndex + 3000);
  
  const rows: ComparisonTableRow[] = [];
  const years = ["2025년", "2024년", "2023년", "당기", "전기"];
  const numberPattern = /(-?\d{1,3}(,\d{3})*(\.\d+)?|-)/g;

  const cleanValue = (val: string) => {
    if (val === '-') return val;
    return val.replace(/[^0-9.-]/g, '');
  };

  for (const year of years) {
    const yearIndex = subText.indexOf(year);
    if (yearIndex !== -1) {
      const lineAfterYear = subText.substring(yearIndex + year.length, yearIndex + year.length + 250);
      const matches = lineAfterYear.match(numberPattern);
      
      if (matches && matches.length >= 3) {
        if (!rows.some(r => r.year === year)) {
          rows.push({
            year,
            expected: cleanValue(matches[0]),
            actual: cleanValue(matches[1]),
            difference: cleanValue(matches[2])
          });
        }
      }
    }
  }

  return { data: rows, page: foundPage };
}

function parseTableRiskPremium(pageTexts: string[]): ExtractedTable<any> {
  const keywords = ["위험보험료", "대비", "예상보험금"];
  let foundPage = -1;

  const strip = (s: string) => s.replace(/\s+/g, '');

  for (let i = 0; i < pageTexts.length; i++) {
    const strippedPage = strip(pageTexts[i]);
    
    let lastIndex = -1;
    let allFoundInOrder = true;
    for (const kw of keywords) {
      const index = strippedPage.indexOf(strip(kw), lastIndex + 1);
      if (index === -1) {
        allFoundInOrder = false;
        break;
      }
      lastIndex = index;
    }
    
    if (allFoundInOrder) {
      foundPage = i + 1;
      break;
    }
  }

  return { data: [], page: foundPage === -1 ? null : foundPage };
}

function extractRows(text: string, categories: string[]): TableRow[] {
  const rows: TableRow[] = [];
  
  // Normalize text for easier matching (replace multiple spaces/newlines with single space)
  const normalizedText = text.replace(/\s+/g, ' ');
  
  const numberPattern = /(-?\d{1,3}(,\d{3})*(\.\d+)?|-)/g;

  const cleanValue = (val: string) => {
    if (val === '-') return val;
    // Remove characters like ',' and '%' but keep digits, '.', and '-'
    return val.replace(/[^0-9.-]/g, '');
  };

  for (const category of categories) {
    // Try to find the category even if it has extra spaces
    const normalizedCategory = category.replace(/\s+/g, ' ');
    const catIndex = normalizedText.indexOf(normalizedCategory);
    
    if (catIndex !== -1) {
      const lineAfterCat = normalizedText.substring(catIndex + normalizedCategory.length, catIndex + normalizedCategory.length + 150);
      const matches = lineAfterCat.match(numberPattern);
      if (matches && matches.length >= 2) {
        rows.push({
          category,
          before: cleanValue(matches[0]),
          after: cleanValue(matches[1])
        });
      } else if (matches && matches.length === 1) {
        rows.push({
          category,
          before: cleanValue(matches[0]),
          after: "-"
        });
      }
    }
  }

  return rows;
}
