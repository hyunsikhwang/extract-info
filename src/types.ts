export interface TableRow {
  [key: string]: string | number | null;
}

export interface ComparisonTableRow extends TableRow {
  category: string;
  expectedLossRatio: string;
  actualLossRatio: string;
  differenceRatio: string;
}

export interface ExtractedTable<T> {
  data: T[];
  page: number | null;
}

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

export interface GeminiExtractionResult {
  comparisonTable: ComparisonTableResult[];
  solvencyTable: SolvencyTableResult[];
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export interface ExtractedData {
  companyName: string | null;
  fileName: string;
  fullText: string;
  table1: ExtractedTable<TableRow>;
  table2: ExtractedTable<TableRow>;
  table3: ExtractedTable<ComparisonTableRow>;
  originalBuffer: ArrayBuffer;
  numPages: number;
  error?: string;
  url?: string;
  geminiData?: GeminiExtractionResult;
}
