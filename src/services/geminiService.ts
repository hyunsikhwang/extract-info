export interface ComparisonTableResult {
  companyName: string;
  category: string;
  expectedLossRatio: string;
  actualLossRatio: string;
  differenceRatio: string;
}

export interface SolvencyTableResult {
  companyName: string;
  measureType: string;
  solvencyRatio: string;
  solvencyAmount: string;
  basicCapital: string;
  supplementaryCapital: string;
  solvencyRequiredAmount: string;
  appliedCapitalReductionAmount: string;
}

export interface RiskPremiumTableResult {
  companyName: string;
  year: string;
  category: string;
  y1: string;
  y2: string;
  y3: string;
  y4: string;
  y5: string;
  y6: string;
  y7: string;
  y8: string;
  y9: string;
  y10: string;
  y11_15: string;
  y16_20: string;
  y21_25: string;
  y26_30: string;
  y30_plus: string;
  presentValue: string;
}

export interface GeminiExtractionResult {
  comparisonTable: ComparisonTableResult[];
  solvencyTable: SolvencyTableResult[];
  riskPremiumTable: RiskPremiumTableResult[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export interface ExtractionOptions {
  extractSolvency: boolean;
  extractComparison: boolean;
  extractRiskPremium: boolean;
}

export async function extractTablesWithGemini(
  pdfBase64: string, 
  mimeType: string = 'application/pdf',
  options: ExtractionOptions = { extractSolvency: true, extractComparison: true, extractRiskPremium: true },
  pdfText?: string
): Promise<GeminiExtractionResult> {
  const response = await fetch('/api/extract-tables', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      pdfBase64,
      mimeType,
      options,
      pdfText,
    }),
  });

  if (!response.ok) {
    let errorMsg = `서버 오류 (${response.status})`;
    try {
      const errData = await response.json();
      if (errData.error) errorMsg = errData.error;
    } catch {
      const text = await response.text();
      if (text) errorMsg = text;
    }
    throw new Error(errorMsg);
  }

  return await response.json();
}
