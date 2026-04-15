import React, { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Upload, FileText, Table, Code, ChevronDown, ChevronUp, AlertCircle, CheckCircle2, Copy, Check, Link as LinkIcon, ArrowRight, Loader2, Download, X, Square } from 'lucide-react';
import { extractTextFromPdf, extractTextFromUrl, ExtractedData, slicePdfPage, mergePdfPages } from './lib/pdf-parser';
import { extractTablesWithGemini, ComparisonTableResult, SolvencyTableResult } from './services/geminiService';

// Helper to convert ArrayBuffer to base64 efficiently using browser native APIs
async function arrayBufferToBase64(buffer: ArrayBuffer): Promise<string> {
  const blob = new Blob([buffer], { type: 'application/pdf' });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // result is "data:application/pdf;base64,..."
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export default function App() {
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [elapsedTime, setElapsedTime] = useState(0);
  const [finalTime, setFinalTime] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ExtractedData[]>([]);
  const [showFullText, setShowFullText] = useState<Record<number, boolean>>({});
  const [urlInput, setUrlInput] = useState('');
  const [inputMode, setInputMode] = useState<'url' | 'file'>('url');
  const [isDownloading, setIsDownloading] = useState<string | null>(null);
  
  const aggregatedComparison = React.useMemo(() => 
    results.flatMap(r => r.geminiData?.comparisonTable || []), 
  [results]);
  
  const aggregatedSolvency = React.useMemo(() => 
    results.flatMap(r => r.geminiData?.solvencyTable || []), 
  [results]);

  const [processingMode, setProcessingMode] = useState<'analysis' | 'full'>('full');
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [tokenUsage, setTokenUsage] = useState({ prompt: 0, candidates: 0 });
  const isStoppingRef = React.useRef(false);

  // Timer effect
  React.useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isLoading) {
      const start = Date.now();
      setFinalTime(null);
      interval = setInterval(() => {
        setElapsedTime(Math.floor((Date.now() - start) / 1000));
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isLoading]);

  const stopProcessing = () => {
    setIsStopping(true);
    isStoppingRef.current = true;
  };

  const clearInput = () => {
    setUrlInput('');
    setError(null);
  };

  const processUrls = async () => {
    if (!urlInput.trim()) {
      setError('URL을 입력해주세요.');
      return;
    }

    const urls = urlInput.split('\n').map(u => u.trim()).filter(u => u !== '');
    if (urls.length === 0) {
      setError('올바른 URL을 입력해주세요.');
      return;
    }

    setIsLoading(true);
    setIsStopping(false);
    isStoppingRef.current = false;
    setProgress({ current: 0, total: urls.length });
    setError(null);
    setResults([]); // Clear previous results
    setTokenUsage({ prompt: 0, candidates: 0 });
    
    const startTime = Date.now();
    const CONCURRENCY = 3;
    let completedCount = 0;
    let nextUrlIndex = 0;

    const worker = async () => {
      while (nextUrlIndex < urls.length && !isStoppingRef.current) {
        const i = nextUrlIndex++;
        const url = urls[i];
        
        try {
          if (!url.startsWith('http')) {
            throw new Error(`올바르지 않은 URL 형식이 포함되어 있습니다: ${url}`);
          }
          
          const result = await extractTextFromUrl(url);
          result.url = url;
          
          setResults(prev => [...prev, result]);

          // Gemini Extraction (Conditional)
          if (processingMode === 'full' && !result.error) {
            await runGeminiExtraction(result);
          } else if (processingMode === 'analysis' && !result.error) {
            // Even in analysis mode, we should generate mergedBuffer if it's FAST
            const isFast = result.table1.page !== null && result.table3.page !== null;
            if (isFast) {
              const pages = new Set<number>();
              pages.add(1);
              if (result.table1.page) { pages.add(result.table1.page); pages.add(result.table1.page + 1); }
              if (result.table2.page) { pages.add(result.table2.page); pages.add(result.table2.page + 1); }
              if (result.table3.page) { pages.add(result.table3.page); pages.add(result.table3.page + 1); }
              const sortedPages = Array.from(pages).sort((a, b) => a - b);
              try {
                const mergedPdf = await mergePdfPages(result.originalBuffer, sortedPages);
                setResults(prev => {
                  const newResults = [...prev];
                  const targetIndex = newResults.findIndex(r => r.id === result.id);
                  if (targetIndex !== -1) {
                    newResults[targetIndex] = {
                      ...newResults[targetIndex],
                      mergedBuffer: mergedPdf.buffer
                    };
                  }
                  return newResults;
                });
              } catch (e) {
                console.warn("Failed to create merged PDF in analysis mode", e);
              }
            }
          }
        } catch (err) {
          console.error(`Error processing ${url}:`, err);
          const errorMessage = err instanceof Error ? err.message : String(err);
          
          // Create a placeholder result for failed extraction
          const failedResult: ExtractedData = {
            companyName: null,
            fileName: url.split('/').pop() || 'unknown.pdf',
            fullText: '',
            table1: { data: [], page: null },
            table2: { data: [], page: null },
            table3: { data: [], page: null },
            originalBuffer: new ArrayBuffer(0),
            numPages: 0,
            error: errorMessage,
            url: url,
            id: Math.random().toString(36).substring(2, 11)
          };
          
          setResults(prev => [...prev, failedResult]);
        } finally {
          completedCount++;
          setProgress(prev => ({ ...prev, current: completedCount }));
        }
      }
    };

    try {
      const workers = Array(Math.min(CONCURRENCY, urls.length)).fill(null).map(async (_, idx) => {
        // Staggered start: wait 500ms * index to avoid simultaneous requests
        if (idx > 0) await new Promise(resolve => setTimeout(resolve, idx * 500));
        return worker();
      });
      await Promise.all(workers);
      
      if (!isStoppingRef.current) setUrlInput('');
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : '전체 처리 중 오류가 발생했습니다.');
    } finally {
      setIsLoading(false);
      setIsStopping(false);
      isStoppingRef.current = false;
      setFinalTime(Math.floor((Date.now() - startTime) / 1000));
    }
  };

  const processFile = async (file: File) => {
    if (file.type !== 'application/pdf') {
      setError('PDF 파일만 업로드 가능합니다.');
      return;
    }

    setIsLoading(true);
    setIsStopping(false);
    setProgress({ current: 1, total: 1 });
    setError(null);
    setResults([]); // Clear previous results
    setTokenUsage({ prompt: 0, candidates: 0 });
    const startTime = Date.now();
    try {
      const result = await extractTextFromPdf(file);
      
      setResults(prev => [...prev, result]);
      
      if (processingMode === 'full' && !result.error) {
        await runGeminiExtraction(result);
      } else if (processingMode === 'analysis' && !result.error) {
        // Even in analysis mode, generate mergedBuffer for FAST documents
        const isFast = result.table1.page !== null && result.table3.page !== null;
        if (isFast) {
          const pages = new Set<number>();
          pages.add(1);
          if (result.table1.page) { pages.add(result.table1.page); pages.add(result.table1.page + 1); }
          if (result.table2.page) { pages.add(result.table2.page); pages.add(result.table2.page + 1); }
          if (result.table3.page) { pages.add(result.table3.page); pages.add(result.table3.page + 1); }
          const sortedPages = Array.from(pages).sort((a, b) => a - b);
          try {
            const mergedPdf = await mergePdfPages(result.originalBuffer, sortedPages);
            setResults(prev => {
              const newResults = [...prev];
              const targetIndex = newResults.findIndex(r => r.id === result.id);
              if (targetIndex !== -1) {
                newResults[targetIndex] = {
                  ...newResults[targetIndex],
                  mergedBuffer: mergedPdf.buffer
                };
              }
              return newResults;
            });
          } catch (e) {
            console.warn("Failed to create merged PDF in analysis mode", e);
          }
        }
      }
    } catch (err) {
      console.error(err);
      setError('PDF 추출 중 오류가 발생했습니다. 파일 형식을 확인해주세요.');
    } finally {
      setIsLoading(false);
      setFinalTime(Math.floor((Date.now() - startTime) / 1000));
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const runGeminiExtraction = async (result: ExtractedData) => {
    const maxRetries = 5;
    let retryCount = 0;

    const attemptExtraction = async (): Promise<void> => {
      let mergedBuffer: ArrayBuffer | undefined = undefined;
      try {
        const isFast = result.table1.page !== null && result.table3.page !== null;
        let pdfBase64 = '';

        // If we already failed once and are retrying, or if it's not fast mode, use original
        if (isFast && retryCount === 0) {
          console.log(`[FAST] Merging relevant pages for ${result.companyName}...`);
          const pages = new Set<number>();
          pages.add(1);
          if (result.table1.page) { pages.add(result.table1.page); pages.add(result.table1.page + 1); }
          if (result.table2.page) { pages.add(result.table2.page); pages.add(result.table2.page + 1); }
          if (result.table3.page) { pages.add(result.table3.page); pages.add(result.table3.page + 1); }

          const sortedPages = Array.from(pages).sort((a, b) => a - b);
          try {
            const mergedPdf = await mergePdfPages(result.originalBuffer, sortedPages);
            mergedBuffer = mergedPdf.buffer;
            pdfBase64 = await arrayBufferToBase64(mergedBuffer);
          } catch (mergeErr) {
            console.warn("Merge failed, falling back to original PDF", mergeErr);
            pdfBase64 = await arrayBufferToBase64(result.originalBuffer);
          }
        } else {
          // NORMAL mode or Fallback: Send original PDF as is
          console.log(`[${retryCount > 0 ? 'RETRY/FALLBACK' : 'NORMAL'}] Sending original PDF for ${result.companyName || result.fileName}...`);
          pdfBase64 = await arrayBufferToBase64(result.originalBuffer);
        }

        const geminiResult = await extractTablesWithGemini(pdfBase64);
        
        // Update the specific result with the gemini data using ID
        setResults(prev => {
          const newResults = [...prev];
          const targetIndex = newResults.findIndex(r => r.id === result.id);
          if (targetIndex !== -1) {
            newResults[targetIndex] = {
              ...newResults[targetIndex],
              geminiData: geminiResult,
              mergedBuffer: mergedBuffer // This ensures the buffer is saved to the state
            };
          }
          return newResults;
        });
        
        if (geminiResult.usageMetadata) {
          setTokenUsage(prev => ({
            prompt: prev.prompt + geminiResult.usageMetadata!.promptTokenCount,
            candidates: prev.candidates + geminiResult.usageMetadata!.candidatesTokenCount,
          }));
        }
      } catch (err: any) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const isRetryableError = 
          errorMessage.includes('Rpc failed') || 
          errorMessage.includes('xhr error') || 
          errorMessage.includes('aborted') || 
          errorMessage.includes('fetch failed') ||
          errorMessage.includes('NetworkError') ||
          errorMessage.includes('502') ||
          errorMessage.includes('503') ||
          errorMessage.includes('504') ||
          errorMessage.includes('timeout') ||
          errorMessage.includes('high demand') ||
          errorMessage.includes('UNAVAILABLE');

        if (isRetryableError && retryCount < maxRetries) {
          retryCount++;
          // Exponential backoff with jitter
          const delay = Math.pow(2, retryCount) * 1000 + Math.random() * 1000;
          console.warn(`[Gemini] Retryable error detected (${errorMessage}). Retrying in ${Math.round(delay)}ms... (Attempt ${retryCount}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          return attemptExtraction();
        }
        
        console.error("Gemini extraction failed for a document:", err);
        
        // Update the specific result with the error using ID
        setResults(prev => {
          const newResults = [...prev];
          const targetIndex = newResults.findIndex(r => r.id === result.id);
          if (targetIndex !== -1) {
            newResults[targetIndex] = {
              ...newResults[targetIndex],
              error: `AI 추출 실패: ${errorMessage}`,
              mergedBuffer: mergedBuffer // Preserve mergedBuffer even on failure
            };
          }
          return newResults;
        });
      }
    };

    await attemptExtraction();
  };

  const downloadPages = async (resultIndex: number, startPage: number, tableName: string) => {
    const result = results[resultIndex];
    if (!result) return;
    
    const downloadId = `${resultIndex}-${tableName}`;
    setIsDownloading(downloadId);
    try {
      // For tables 2, 3, 4, we take 2 pages if possible
      const endPage = tableName === 'company_info' ? startPage : Math.min(startPage + 1, result.numPages);
      
      const pdfBytes = await slicePdfPage(result.originalBuffer, startPage, endPage);
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const company = result.companyName || 'unknown';
      const pageSuffix = startPage === endPage ? `p${startPage}` : `p${startPage}-${endPage}`;
      link.download = `${company}_${tableName}_${pageSuffix}.pdf`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      setError('PDF 페이지 다운로드 중 오류가 발생했습니다.');
    } finally {
      setIsDownloading(null);
    }
  };

  const copyToClipboard = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(id);
      setTimeout(() => setCopyStatus(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const downloadAsTxt = (text: string, filename: string) => {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const generateComparisonTxt = () => {
    const header = ['회사명', '구분', '예상손해율', '실제손해율', '보험금예실차비율'].join('\t');
    const rows = aggregatedComparison.map(row => 
      [row.companyName, row.category, row.expectedLossRatio, row.actualLossRatio, row.differenceRatio].join('\t')
    );
    return [header, ...rows].join('\n');
  };

  const generateSolvencyTxt = () => {
    const header = [
      '회사명', '경과조치구분', '지급여력비율', '지급여력금액', '기본자본', '보완자본', 
      '지급여력기준금액', '자본감소분 경과조치 적용금액'
    ].join('\t');
    const rows = aggregatedSolvency.map(row => 
      [
        row.companyName, row.measureType, row.solvencyRatio, row.solvencyAmount, row.basicCapital, 
        row.supplementaryCapital, row.solvencyRequiredAmount, row.appliedCapitalReductionAmount
      ].join('\t')
    );
    return [header, ...rows].join('\n');
  };

  const toggleFullText = (index: number) => {
    setShowFullText(prev => ({
      ...prev,
      [index]: !prev[index]
    }));
  };

  const fastCount = results.filter(r => r.table1.page !== null && r.table3.page !== null).length;
  const normalCount = results.length - fastCount;

  // Gemini 1.5 Flash Pricing (Actual as of April 2024)
  // Input: $0.075 / 1M tokens (< 128k context) -> $0.000000075 per token
  // Output: $0.30 / 1M tokens (< 128k context) -> $0.0000003 per token
  // Exchange Rate: 1 USD = 1,400 KRW (Approximate)
  const estimatedCostUSD = (tokenUsage.prompt * 0.000000075) + (tokenUsage.candidates * 0.0000003);
  const estimatedCostKRW = estimatedCostUSD * 1400;

  return (
    <div className="min-h-screen bg-[#F8F9FA] text-[#1A1A1A] font-sans p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8 text-center">
          <motion.h1 
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-2xl font-bold tracking-tight mb-2"
            id="app-title"
          >
            경영공시 정보추출
          </motion.h1>
          <div className="flex items-center justify-center gap-4 text-[10px] font-bold">
            <div className="flex items-center gap-1">
              <span className="text-gray-400">FAST:</span>
              <span className="text-blue-600">{fastCount}</span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-gray-400">NORMAL:</span>
              <span className="text-gray-600">{normalCount}</span>
            </div>
            {(isLoading || finalTime !== null) && (
              <div className="flex items-center gap-4 border-l pl-4">
                <div className="flex items-center gap-1">
                  <span className="text-gray-400">RUNTIME:</span>
                  <span className="text-blue-600">{isLoading ? elapsedTime : finalTime}s</span>
                </div>
                {processingMode === 'full' && (tokenUsage.prompt > 0 || tokenUsage.candidates > 0) && (
                  <div className="flex items-center gap-3 border-l pl-4">
                    <div className="flex items-center gap-1">
                      <span className="text-gray-400">TOKENS:</span>
                      <span className="text-gray-600">
                        {tokenUsage.prompt.toLocaleString()} (in) / {tokenUsage.candidates.toLocaleString()} (out)
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-gray-400">COST:</span>
                      <span className="text-green-600 font-bold">
                        ${estimatedCostUSD.toFixed(5)} (약 {Math.round(estimatedCostKRW).toLocaleString()}원)
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>

        <div className="space-y-4 mb-8">
          <div className="flex justify-center gap-1.5 mb-2">
            <button 
              onClick={() => { setInputMode('url'); setError(null); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${inputMode === 'url' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-100'}`}
            >
              URL 여러 개 입력
            </button>
            <button 
              onClick={() => { setInputMode('file'); setError(null); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${inputMode === 'file' ? 'bg-blue-600 text-white' : 'bg-white text-gray-500 hover:bg-gray-100'}`}
            >
              파일 업로드
            </button>
          </div>

          {inputMode === 'url' ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.99 }}
              animate={{ opacity: 1, scale: 1 }}
              className="bg-white p-4 rounded-2xl shadow-sm border border-gray-100"
            >
              <div className="flex flex-col gap-3">
                <div className="relative">
                  <div className="absolute top-3 left-3 text-gray-400">
                    <LinkIcon size={16} />
                  </div>
                  <textarea
                    placeholder="PDF 문서 URL들을 입력하세요 (줄바꿈으로 구분)&#10;https://example1.com/report.pdf&#10;https://example2.com/report.pdf"
                    value={urlInput}
                    onChange={(e) => setUrlInput(e.target.value)}
                    rows={4}
                    className="w-full pl-10 pr-3 py-3 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all font-mono text-xs leading-tight"
                  />
                  {urlInput && !isLoading && (
                    <button 
                      onClick={clearInput}
                      className="absolute top-3 right-3 p-1 text-gray-400 hover:text-red-500 transition-colors"
                      title="입력창 초기화"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-4 py-1">
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">작업 단계 선택:</span>
                  <div className="flex bg-gray-100 p-1 rounded-lg">
                    <button
                      onClick={() => setProcessingMode('analysis')}
                      className={`px-3 py-1.5 rounded-md text-[10px] font-bold transition-all ${processingMode === 'analysis' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                      PDF 분석만 (FAST/NORMAL)
                    </button>
                    <button
                      onClick={() => setProcessingMode('full')}
                      className={`px-3 py-1.5 rounded-md text-[10px] font-bold transition-all ${processingMode === 'full' ? 'bg-white text-blue-600 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                      AI 최종 추출 (통합 테이블)
                    </button>
                  </div>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={processUrls}
                    disabled={isLoading || !urlInput.trim()}
                    className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white font-semibold py-3 rounded-xl transition-all flex items-center justify-center gap-2 text-sm shadow-md shadow-blue-500/10"
                  >
                    {isLoading ? (
                      <div className="flex items-center gap-2">
                        <Loader2 className="animate-spin" size={16} />
                        <span>처리 중 ({progress.current}/{progress.total})</span>
                      </div>
                    ) : (
                      <>
                        모든 문서 분석 시작
                        <ArrowRight size={16} />
                      </>
                    )}
                  </button>
                  {isLoading && (
                    <button
                      onClick={stopProcessing}
                      className="px-4 bg-red-50 text-red-600 border border-red-100 hover:bg-red-100 font-semibold rounded-xl transition-all flex items-center justify-center gap-2 text-sm"
                    >
                      <Square size={14} fill="currentColor" />
                      중지
                    </button>
                  )}
                </div>
                
                {isLoading && progress.total > 0 && (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex justify-between text-[10px] text-gray-500 font-medium">
                      <span>전체 진행률 ({progress.current}/{progress.total})</span>
                      <span>{Math.round((progress.current / progress.total) * 100)}%</span>
                    </div>
                    <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <motion.div 
                        className="h-full bg-blue-500"
                        initial={{ width: 0 }}
                        animate={{ width: `${(progress.current / progress.total) * 100}%` }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
          ) : (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              className={`
                relative border-2 border-dashed rounded-2xl p-8 text-center transition-all duration-300
                ${isDragging ? 'border-blue-500 bg-blue-50' : 'border-gray-200 bg-white'}
                ${isLoading ? 'opacity-50 pointer-events-none' : 'hover:border-gray-300'}
              `}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={onDrop}
              id="upload-zone"
            >
              <input
                type="file"
                accept=".pdf"
                onChange={onFileChange}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                id="file-input"
              />
              <div className="flex flex-col items-center gap-3">
                <div className="w-12 h-12 bg-blue-50 text-blue-600 rounded-xl flex items-center justify-center">
                  <Upload size={24} />
                </div>
                <div>
                  <p className="text-sm font-semibold">
                    {isLoading ? '문서 분석 중...' : 'PDF 파일을 드래그하여 놓으세요'}
                  </p>
                  <p className="text-[10px] text-gray-400">또는 클릭하여 파일을 선택하세요</p>
                </div>
              </div>
            </motion.div>
          )}

          {error && (
            <motion.div 
              initial={{ opacity: 0, y: 5 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-3 bg-red-50 border border-red-100 text-red-600 rounded-xl flex items-center gap-2 text-xs"
              id="error-message"
            >
              <AlertCircle size={16} />
              <p>{error}</p>
            </motion.div>
          )}
        </div>

        <div className="space-y-8">
          {/* Aggregated Tables Section */}
          {results.length > 0 && (
            <div className="space-y-8 mb-12">
              <div className="border-t pt-8">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <Table className="text-blue-600" size={20} />
                    1. 보험금 예실차비율 통합 테이블
                  </h2>
                  <div className="flex gap-2">
                    <button
                      onClick={() => copyToClipboard(generateComparisonTxt(), 'comparison')}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 text-gray-600 rounded-lg text-[10px] font-bold transition-all border border-gray-200"
                    >
                      {copyStatus === 'comparison' ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                      {copyStatus === 'comparison' ? '복사됨' : '클립보드 복사'}
                    </button>
                    <button
                      onClick={() => downloadAsTxt(generateComparisonTxt(), '보험금_예실차비율_통합.txt')}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded-lg text-[10px] font-bold transition-all border border-blue-100"
                    >
                      <Download size={14} />
                      TXT 다운로드
                    </button>
                  </div>
                </div>
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
                  <table className="w-full text-[11px] text-left border-collapse">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-100">
                        <th className="p-2 font-bold border-r border-gray-100">회사명</th>
                        <th className="p-2 font-bold border-r border-gray-100">구분</th>
                        <th className="p-2 font-bold border-r border-gray-100">예상손해율</th>
                        <th className="p-2 font-bold border-r border-gray-100">실제손해율</th>
                        <th className="p-2 font-bold">보험금예실차비율</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {aggregatedComparison.length > 0 ? (
                        aggregatedComparison.map((row, idx) => (
                          <tr key={idx} className="hover:bg-blue-50/30 transition-colors">
                            <td className="p-2 border-r border-gray-100 font-medium">{row.companyName}</td>
                            <td className="p-2 border-r border-gray-100">{row.category}</td>
                            <td className="p-2 border-r border-gray-100 text-right">{row.expectedLossRatio}</td>
                            <td className="p-2 border-r border-gray-100 text-right">{row.actualLossRatio}</td>
                            <td className="p-2 text-right font-bold text-blue-600">{row.differenceRatio}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={5} className="p-8 text-center text-gray-400 italic">
                            {isLoading ? "데이터 분석 중..." : "추출된 데이터가 없습니다."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="mt-8">
                <div className="flex justify-between items-center mb-4">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <Table className="text-blue-600" size={20} />
                    2. 지급여력비율 통합 테이블
                  </h2>
                  <div className="flex gap-2">
                    <button
                      onClick={() => copyToClipboard(generateSolvencyTxt(), 'solvency')}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 text-gray-600 rounded-lg text-[10px] font-bold transition-all border border-gray-200"
                    >
                      {copyStatus === 'solvency' ? <Check size={14} className="text-green-600" /> : <Copy size={14} />}
                      {copyStatus === 'solvency' ? '복사됨' : '클립보드 복사'}
                    </button>
                    <button
                      onClick={() => downloadAsTxt(generateSolvencyTxt(), '지급여력비율_통합.txt')}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded-lg text-[10px] font-bold transition-all border border-blue-100"
                    >
                      <Download size={14} />
                      TXT 다운로드
                    </button>
                  </div>
                </div>
                <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-x-auto">
                  <table className="w-full text-[10px] text-left border-collapse min-w-[1200px]">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-100">
                        <th className="p-2 font-bold border-r border-gray-100 sticky left-0 bg-gray-50 z-10">회사명</th>
                        <th className="p-2 font-bold border-r border-gray-100">경과조치구분</th>
                        <th className="p-2 font-bold border-r border-gray-100">지급여력비율</th>
                        <th className="p-2 font-bold border-r border-gray-100">지급여력금액</th>
                        <th className="p-2 font-bold border-r border-gray-100">기본자본</th>
                        <th className="p-2 font-bold border-r border-gray-100">보완자본</th>
                        <th className="p-2 font-bold border-r border-gray-100">지급여력기준금액</th>
                        <th className="p-2 font-bold">자본감소분 경과조치 적용금액</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {aggregatedSolvency.length > 0 ? (
                        aggregatedSolvency.map((row, idx) => (
                          <tr key={idx} className="hover:bg-blue-50/30 transition-colors">
                            <td className="p-2 border-r border-gray-100 font-medium sticky left-0 bg-white z-10">{row.companyName}</td>
                            <td className="p-2 border-r border-gray-100">{row.measureType}</td>
                            <td className="p-2 border-r border-gray-100 text-right font-bold text-blue-600">{row.solvencyRatio}</td>
                            <td className="p-2 border-r border-gray-100 text-right">{row.solvencyAmount}</td>
                            <td className="p-2 border-r border-gray-100 text-right">{row.basicCapital}</td>
                            <td className="p-2 border-r border-gray-100 text-right">{row.supplementaryCapital}</td>
                            <td className="p-2 border-r border-gray-100 text-right">{row.solvencyRequiredAmount}</td>
                            <td className="p-2 text-right">{row.appliedCapitalReductionAmount}</td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={8} className="p-8 text-center text-gray-400 italic">
                            {isLoading ? "데이터 분석 중..." : "추출된 데이터가 없습니다."}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {results.map((data, resultIndex) => (
            <motion.div 
              key={resultIndex}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-2 border-t pt-8 first:border-t-0 first:pt-0"
            >
              <div className={`flex justify-between items-center bg-white p-4 rounded-2xl shadow-sm border ${data.error ? 'border-red-100 bg-red-50/30' : 'border-gray-100'} mb-4`}>
                <div className="flex items-center gap-2.5">
                  <div className={`w-8 h-8 ${data.error ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'} rounded-lg flex items-center justify-center`}>
                    {data.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="font-bold text-sm leading-tight">
                        문서 #{resultIndex + 1} {data.error ? '추출 실패' : '추출 완료'}
                      </h2>
                      {!data.error && (
                        data.table1.page !== null && data.table3.page !== null ? (
                          <span className="px-1.5 py-0.5 bg-blue-600 text-white text-[8px] font-black rounded-sm tracking-tighter">FAST</span>
                        ) : (
                          <span className="px-1.5 py-0.5 bg-gray-200 text-gray-600 text-[8px] font-black rounded-sm tracking-tighter">NORMAL</span>
                        )
                      )}
                    </div>
                    <p className="text-[10px] text-gray-500 truncate max-w-[200px] md:max-w-md">
                      {data.error ? data.fileName : (data.companyName || '회사명 미상')}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      if (data.originalBuffer.byteLength > 0) {
                        const blob = new Blob([data.originalBuffer], { type: 'application/pdf' });
                        const url = URL.createObjectURL(blob);
                        const link = document.createElement('a');
                        link.href = url;
                        link.download = data.fileName;
                        link.click();
                        URL.revokeObjectURL(url);
                      } else if (data.url) {
                        const proxyUrl = `/api/proxy-pdf?url=${encodeURIComponent(data.url)}`;
                        window.open(proxyUrl, '_blank');
                      }
                    }}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[10px] font-bold transition-all border ${
                      data.error 
                        ? 'bg-red-100 hover:bg-red-200 text-red-700 border-red-200' 
                        : 'bg-gray-100 hover:bg-gray-200 text-gray-700 border-gray-200'
                    }`}
                  >
                    <Download size={14} />
                    원본 PDF
                  </button>

                  {data.mergedBuffer && (
                    <button 
                      onClick={() => {
                        if (data.mergedBuffer && data.mergedBuffer.byteLength > 0) {
                          const blob = new Blob([data.mergedBuffer], { type: 'application/pdf' });
                          const url = URL.createObjectURL(blob);
                          const link = document.createElement('a');
                          link.href = url;
                          link.download = `merged_${data.fileName}`;
                          link.click();
                          URL.revokeObjectURL(url);
                        }
                      }}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded-lg text-[10px] font-bold transition-all border border-blue-200"
                    >
                      <Download size={14} />
                      병합 PDF (AI용)
                    </button>
                  )}

                  <button 
                    onClick={() => setResults(prev => prev.filter((_, i) => i !== resultIndex))}
                    className="px-3 py-1 text-[10px] font-medium text-red-500 hover:bg-red-50 rounded-md transition-colors"
                  >
                    삭제
                  </button>
                </div>
              </div>

              {data.error ? (
                <div className="bg-red-50 border border-red-100 rounded-xl p-4 text-xs text-red-700 flex items-start gap-3">
                  <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="font-bold mb-1">추출 중 오류가 발생했습니다.</p>
                    <p className="opacity-80 break-all leading-relaxed">{data.error}</p>
                    {data.url && (
                      <p className="mt-2 text-[10px] opacity-60">URL: {data.url}</p>
                    )}
                  </div>
                </div>
              ) : (
                <>
                  {/* Grouped Extraction Items Card */}
                  <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden divide-y divide-gray-50">
                    {/* 1. Company Name */}
                    <div className="p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5">
                          <FileText className="text-blue-600" size={16} />
                          <h3 className="font-bold text-xs">1. 회사명: {data.companyName || '추출 실패'}</h3>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 text-[9px] font-bold rounded border border-blue-100">
                            PAGE 1
                          </span>
                          <button
                            onClick={() => downloadPages(resultIndex, 1, 'company_info')}
                            disabled={isDownloading !== null}
                            className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-all"
                            title="1페이지 다운로드"
                          >
                            {isDownloading === `${resultIndex}-company_info` ? (
                              <Loader2 size={12} className="animate-spin" />
                            ) : (
                              <Download size={12} />
                            )}
                          </button>
                        </div>
                      </div>
                      <span className="text-[9px] font-mono text-gray-400">COMPANY_NAME</span>
                    </div>

                    {/* 2. Table 1 */}
                    <div className="p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5">
                          <Table className="text-blue-600" size={16} />
                          <h3 className="font-bold text-xs">2. 공통적용 경과조치관련</h3>
                        </div>
                        {data.table1.page && (
                          <div className="flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 text-[9px] font-bold rounded border border-blue-100">
                              PAGE {data.table1.page}-{Math.min(data.table1.page + 1, data.numPages)}
                            </span>
                            <button
                              onClick={() => downloadPages(resultIndex, data.table1.page!, 'table1')}
                              disabled={isDownloading !== null}
                              className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-all"
                              title="2페이지 다운로드"
                            >
                              {isDownloading === `${resultIndex}-table1` ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Download size={12} />
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                      <span className="text-[9px] font-mono text-gray-400">TABLE_01</span>
                    </div>

                    {/* 3. Table 2 */}
                    <div className="p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5">
                          <Table className="text-blue-600" size={16} />
                          <h3 className="font-bold text-xs">3. 자본감소분 경과조치</h3>
                        </div>
                        {data.table2.page && (
                          <div className="flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 text-[9px] font-bold rounded border border-blue-100">
                              PAGE {data.table2.page}-{Math.min(data.table2.page + 1, data.numPages)}
                            </span>
                            <button
                              onClick={() => downloadPages(resultIndex, data.table2.page!, 'table2')}
                              disabled={isDownloading !== null}
                              className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-all"
                              title="2페이지 다운로드"
                            >
                              {isDownloading === `${resultIndex}-table2` ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Download size={12} />
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                      <span className="text-[9px] font-mono text-gray-400">TABLE_02</span>
                    </div>

                    {/* 4. Table 3 */}
                    <div className="p-3 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-1.5">
                          <Table className="text-blue-600" size={16} />
                          <h3 className="font-bold text-xs">4. 보험금 예실차비율</h3>
                        </div>
                        {data.table3.page && (
                          <div className="flex items-center gap-1.5">
                            <span className="px-1.5 py-0.5 bg-blue-50 text-blue-600 text-[9px] font-bold rounded border border-blue-100">
                              PAGE {data.table3.page}-{Math.min(data.table3.page + 1, data.numPages)}
                            </span>
                            <button
                              onClick={() => downloadPages(resultIndex, data.table3.page!, 'table3')}
                              disabled={isDownloading !== null}
                              className="p-1 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded transition-all"
                              title="2페이지 다운로드"
                            >
                              {isDownloading === `${resultIndex}-table3` ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Download size={12} />
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                      <span className="text-[9px] font-mono text-gray-400">TABLE_03</span>
                    </div>
                  </section>

                  {/* Full Text Section */}
                  <section className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                    <button 
                      onClick={() => toggleFullText(resultIndex)}
                      className="w-full p-3 flex items-center justify-between hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-1.5">
                        <FileText className="text-gray-400" size={16} />
                        <h3 className="font-bold text-xs">추출된 전문 텍스트 <span className="ml-2 text-gray-400 font-normal">({data.fileName})</span></h3>
                      </div>
                      {showFullText[resultIndex] ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                    </button>
                    <AnimatePresence>
                      {showFullText[resultIndex] && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden"
                        >
                          <div className="p-3 pt-0 border-t border-gray-50">
                            <div className="bg-gray-50 p-3 rounded-xl text-[10px] text-gray-600 font-mono whitespace-pre-wrap max-h-[300px] overflow-y-auto leading-normal">
                              {data.fullText}
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </section>
                </>
              )}
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  );
}
