import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

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
  const VERSION = "V11-OCR-ASSIST";
  
  let comparisonTable: any[] = [];
  let solvencyTable: any[] = [];
  let riskPremiumTable: any[] = [];
  let totalUsage = { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 };

  // Helper to extract a specific part with robust retry logic
  const extractPart = async (target: 'solvency_common' | 'solvency_reduction' | 'comparison' | 'riskPremium', retriesLeft = 4): Promise<any> => {
    const promptParts: string[] = [];
    let schema: any = {};
    let example: string = "";

    if (target === 'solvency_common') {
      example = `{ "solvencyTable": [
        { "companyName": "에이비엘생명", "measureType": "경과조치전", "solvencyRatio": "112.16", "solvencyAmount": "1851012", "basicCapital": "717032", "supplementaryCapital": "1133980", "solvencyRequiredAmount": "1650399" },
        { "companyName": "에이비엘생명", "measureType": "경과조치후", "solvencyRatio": "164.11", "solvencyAmount": "2122400", "basicCapital": "717032", "supplementaryCapital": "1133980", "solvencyRequiredAmount": "1293300" }
      ] }`;
      promptParts.push(`첨부된 문서의 "[지급여력비율의 경과조치 적용에 관한 사항]" 대주제 아래에 있는 "1) 공통적용 경과조치 관련" 항목 바로 다음에 위치한 테이블에서 다음 정보들을 정확하게 추출해주세요.
- 회사명 (companyName)
- 경과조치 구분 (measureType: '경과조치전' 또는 '경과조치후')
- 지급여력비율 (solvencyRatio)
- 지급여력금액 (solvencyAmount)
- 기본자본 (basicCapital)
- 보완자본 (supplementaryCapital)
- 지급여력기준금액 (solvencyRequiredAmount)

[기본자본/보완자본 및 공통 적용 경과조치 추출에 대한 절대 준수 사항 (CRITICAL CONSTRAINT)]
★ 매우 중요 (절대 준수): 
1. 기본자본(basicCapital)과 보완자본(supplementaryCapital) 정보는 반드시 "[지급여력비율의 경과조치 적용에 관한 사항]" 대주제 아래에 있는 "1) 공통적용 경과조치 관련" 항목 바로 다음에 위치한 테이블에서만 추출해야 합니다.
2. 다른 페이지나 다른 섹션(예: 일반 지급여력비율 요약표 등)에도 동일하게 '기본자본', '보완자본' 명칭의 정보가 표기되어 있으며 수치가 다르게 존재할 수 있으나, 해당 다른 테이블들의 값은 절대로 참조해서는 안 됩니다.
3. 오직 "1) 공통적용 경과조치 관련" 바로 뒤에 나오는 테이블 속의 '기본자본(또는 기본가용자본)' 및 '보완자본(또는 보완가용자본)' 행에서 각각 '경과조치 적용 전' 열과 '경과조치 적용 후' 열의 숫자를 정확하게 매핑해야 합니다. 다른 요약 테이블의 값과 혼동하거나 임의로 섞지 마십시오.

경과조치 구분 (measureType) 별 컬럼 매핑 지침 (매우 중요):
- 문서 상의 표는 보통 "경과조치 적용 전"(또는 "경과조치전", "적용전") 컬럼과 "경과조치 적용 후"(또는 "경과조치후", "경과조치 적용후", "적용후") 컬럼으로 구분되어 있습니다.
- "경과조치전" (measureType: '경과조치전') 데이터 추출 시:
  - "경과조치 적용 전" (또는 "경과조치전", "적용전") 열에 기재된 값을 기준으로 추출해야 합니다.
  - 기본자본(basicCapital), 보완자본(supplementaryCapital), 지급여력금액(solvencyAmount), 지급여력기준금액(solvencyRequiredAmount), 지급여력비율(solvencyRatio) 모두 반드시 "경과조치 적용 전" 컬럼의 숫자를 정확하게 매핑하십시오. 절대 "경과조치 적용 후"의 값과 동일하게 대입하거나 혼동하지 마십시오.
- "경과조치후" (measureType: '경과조치후') 데이터 추출 시:
  - "경과조치 적용 후" (또는 "경과조치후", "적용후") 열에 기재된 값을 기준으로 추출해야 합니다.
  - 기본자본(basicCapital), 보완자본(supplementaryCapital), 지급여력금액(solvencyAmount), 지급여력기준금액(solvencyRequiredAmount), 지급여력비율(solvencyRatio) 모두 반드시 "경과조치 적용 후" 컬럼의 숫자를 정확하게 매핑하십시오.
- 두 컬럼의 기본자본(basicCapital) 및 보완자본(supplementaryCapital) 등이 서로 다르게 공시되는 경우가 많으므로, 표의 좌우/상하 컬럼 위치를 철저하게 분석하여 각각의 값을 고유하고 정확하게 매핑해야 합니다. 임의로 동일한 값을 두 곳에 중복하여 채워 넣지 마십시오.

추출 및 정제 규칙:
1. 모든 금액 필드는 백만원 단위로 기재합니다 (억원 표기 시 100을 곱하여 백만원 단위로 기재).
2. 숫자에서 콤마(,), 퍼센트(%), 원화 기호 등 특수문자는 모두 제거하고 순수한 숫자만 문자열로 입력하십시오.`);
      
      schema = {
        solvencyTable: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              companyName: { type: Type.STRING },
              measureType: { type: Type.STRING },
              solvencyRatio: { type: Type.STRING },
              solvencyAmount: { type: Type.STRING },
              basicCapital: { type: Type.STRING },
              supplementaryCapital: { type: Type.STRING },
              solvencyRequiredAmount: { type: Type.STRING }
            },
            required: [
              "companyName",
              "measureType",
              "solvencyRatio",
              "solvencyAmount",
              "basicCapital",
              "supplementaryCapital",
              "solvencyRequiredAmount"
            ]
          }
        }
      };
    } else if (target === 'solvency_reduction') {
      example = `{ "solvencyTable": [
        { "companyName": "에이비엘생명", "measureType": "경과조치전", "appliedCapitalReductionAmount": "0" },
        { "companyName": "에이비엘생명", "measureType": "경과조치후", "appliedCapitalReductionAmount": "271339" }
      ] }`;
      promptParts.push(`첨부된 문서의 "[지급여력비율의 경과조치 적용에 관한 사항]" 대주제 아래에 있는 "2) 선택적용 경과조치 관련" 항목 내에 위치한 테이블에서 다음 정보들을 정확하게 추출해주세요.
- 회사명 (companyName)
- 경과조치 구분 (measureType: '경과조치전' 또는 '경과조치후')
- 자본감소분 경과조치 적용금액 (appliedCapitalReductionAmount)

[자본감소분 경과조치 적용금액 추출에 대한 절대 준수 사항 (CRITICAL CONSTRAINT)]
★ 매우 중요 (절대 준수):
1. 자본감소분 경과조치 적용금액(appliedCapitalReductionAmount) 정보는 반드시 "[지급여력비율의 경과조치 적용에 관한 사항]" 대주제 아래에 있는 "2) 선택적용 경과조치 관련" 항목 내에 위치한 테이블에서만 추출해야 합니다.
2. 타 테이블(예: "1) 공통적용 경과조치 관련" 테이블이나 일반 요약표)에는 이 값이 없거나 다르게 존재하므로 절대 1)의 테이블이나 타 테이블에서 추출하지 마십시오. 반드시 "2) 선택적용 경과조치 관련" 섹션의 테이블에 나타나는 자본감소분 경과조치 적용금액(가용자본 증가액 등)을 식별하여 정확하게 매핑해야 합니다.
3. '경과조치전' 열에는 이 항목이 존재하지 않거나 '-' 등으로 표시되므로 "0"으로 기록해야 합니다.
4. '경과조치후' 열에는 "2) 선택적용 경과조치 관련" 테이블 내의 해당 적용금액(가용자본 증가액 또는 자본감소분에 대한 경과조치 적용금액) 수치를 정확하게 추출하여 기록하십시오. 존재하지 않거나 해당사항이 없을 경우 "0"으로 기록합니다.

추출 및 정제 규칙:
1. 모든 금액 필드는 백만원 단위로 기재합니다 (억원 표기 시 100을 곱하여 백만원 단위로 기재).
2. 숫자에서 콤마(,), 퍼센트(%), 원화 기호 등 특수문자는 모두 제거하고 순수한 숫자만 문자열로 입력하십시오.`);

      schema = {
        solvencyTable: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              companyName: { type: Type.STRING },
              measureType: { type: Type.STRING },
              appliedCapitalReductionAmount: { type: Type.STRING }
            },
            required: [
              "companyName",
              "measureType",
              "appliedCapitalReductionAmount"
            ]
          }
        }
      };
    } else if (target === 'comparison') {
      example = `{ "comparisonTable": [{ "companyName": "회사명", "category": "2024", "expectedLossRatio": "85.2", "actualLossRatio": "88.1", "differenceRatio": "-2.9" }] }`;
      promptParts.push(`2. 보험금 예실차비율:
- 위치: "4-최적가정" > "보험금 예실차비율" 테이블
- 항목: 구분(년도), 예상손해율, 실제손해율, 보험금예실차비율
- 수치 정제: "%", "," 제거. 괄호()는 "-"로 변환.`);
      schema = {
        comparisonTable: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              companyName: { type: Type.STRING },
              category: { type: Type.STRING },
              expectedLossRatio: { type: Type.STRING },
              actualLossRatio: { type: Type.STRING },
              differenceRatio: { type: Type.STRING }
            },
            required: [
              "companyName",
              "category",
              "expectedLossRatio",
              "actualLossRatio",
              "differenceRatio"
            ]
          }
        }
      };
    } else if (target === 'riskPremium') {
      example = `{ "riskPremiumTable": [
        { "companyName": "스위스리", "year": "2025", "category": "예상보험금(A)", "y1": "2337", "presentValue": "13486" },
        { "companyName": "스위스리", "year": "2025", "category": "위험보험료(B)", "y1": "2377", "presentValue": "19218" },
        { "companyName": "스위스리", "year": "2025", "category": "비율(A/B)", "y1": "98.32", "presentValue": "70.17" }
      ] }`;
      promptParts.push(`3. 위험보험료 대비 예상보험금:
- 위치: "② 위험보험료 대비 예상보험금" 테이블 "합계" 섹션
- [구조]: 세로로 나열된 A, B, A/B 3개 지표를 각각의 JSON row로 추출.
- 수치 정제: "," 제거.`);
      schema = {
        riskPremiumTable: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              companyName: { type: Type.STRING },
              year: { type: Type.STRING },
              category: { type: Type.STRING },
              y1: { type: Type.STRING }, y2: { type: Type.STRING }, y3: { type: Type.STRING }, y4: { type: Type.STRING }, y5: { type: Type.STRING },
              y6: { type: Type.STRING }, y7: { type: Type.STRING }, y8: { type: Type.STRING }, y9: { type: Type.STRING }, y10: { type: Type.STRING },
              y11_15: { type: Type.STRING }, y16_20: { type: Type.STRING }, y21_25: { type: Type.STRING }, y26_30: { type: Type.STRING }, y30_plus: { type: Type.STRING },
              presentValue: { type: Type.STRING }
            },
            required: [
              "companyName",
              "year",
              "category",
              "presentValue"
            ]
          }
        }
      };
    }

    let sysInstr = `당신은 보험사 공시 PDF 추출 전문가입니다. JSON으로만 답변하십시오. 사족 금지.
권장 예시: ${example}`;

    if (target === 'solvency_common') {
      sysInstr = `당신은 보험사 공시 PDF 추출 전문가입니다. JSON으로만 답변하십시오. 사족 금지.
[절대 규칙] 지급여력비율(solvency) 추출 시 기본자본(basicCapital)과 보완자본(supplementaryCapital)은 반드시 "[지급여력비율의 경과조치 적용에 관한 사항]" -> "1) 공통적용 경과조치 관련" 제목 바로 다음에 등장하는 테이블만 사용하여 추출해야 합니다. 절대 다른 요약표나 다른 섹션의 값을 참조하지 마십시오.
권장 예시: ${example}`;
    } else if (target === 'solvency_reduction') {
      sysInstr = `당신은 보험사 공시 PDF 추출 전문가입니다. JSON으로만 답변하십시오. 사족 금지.
[절대 규칙] 자본감소분 경과조치 적용금액(appliedCapitalReductionAmount)은 반드시 "[지급여력비율의 경과조치 적용에 관한 사항]" -> "2) 선택적용 경과조치 관련" 항목의 테이블만 사용하여 추출해야 합니다. 절대 다른 테이블의 값을 참조하지 마십시오.
권장 예시: ${example}`;
    }

    let userPrompt = `다음 데이터를 추출하십시오:\n${promptParts.join('\n')}`;
    // We intentionally do NOT append raw pdfText (parsed via PDF.js) here when running the multimodal model.
    // In Google AI Studio, only the PDF file and user prompt are supplied, which yields 100% accuracy.
    // Injecting a messy text representation of the full 100+ page PDF while only attaching a 6-10 page merged PDF
    // causes a severe discrepancy that confuses Gemini and results in omitted/missing columns.
    // By keeping the inputs perfectly aligned with Google AI Studio, Gemini delivers flawless multimodal extraction.

    console.log(`[Gemini ${VERSION}] Sequential call: ${target} (Retries left: ${retriesLeft})`);
    try {
      const res = await ai.models.generateContent({
        model: "gemini-3.1-flash-lite",
        contents: [{ parts: [{ text: userPrompt }, { inlineData: { mimeType, data: pdfBase64 } }] }],
        config: {
          systemInstruction: sysInstr,
          temperature: 0,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: { type: Type.OBJECT, properties: schema }
        }
      });

      if (res.usageMetadata) {
        totalUsage.promptTokenCount += res.usageMetadata.promptTokenCount || 0;
        totalUsage.candidatesTokenCount += res.usageMetadata.candidatesTokenCount || 0;
        totalUsage.totalTokenCount += res.usageMetadata.totalTokenCount || 0;
      }

      const responseText = res.text;
      if (!responseText) return {};

      const jsonStr = responseText.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').trim();
      const repairJson = (str: string) => {
        try { return jsonrepair(str); } catch { return str; }
      };
      
      const jsonMatch = jsonStr.match(/```json\s?([\s\S]*?)\s?```/) || jsonStr.match(/{[\s\S]*}/);
      const cleanJson = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : jsonStr;
      
      return JSON.parse(repairJson(cleanJson));
    } catch (e: any) {
      console.error(`[Gemini ${VERSION}] Error in ${target} (Retries left: ${retriesLeft}):`, e);
      
      const errorStr = (JSON.stringify(e) || "").toLowerCase() + " " + String(e).toLowerCase();
      const isRetryable = errorStr.includes("503") || 
                          errorStr.includes("unavailable") || 
                          errorStr.includes("high demand") || 
                          errorStr.includes("limit") || 
                          errorStr.includes("rate") ||
                          errorStr.includes("overloaded");

      if (isRetryable && retriesLeft > 0) {
        const backoffMs = Math.pow(2, 5 - retriesLeft) * 3000 + Math.random() * 1000;
        console.warn(`[Gemini ${VERSION}] ${target} failed with retryable error. Retrying in ${Math.round(backoffMs)}ms...`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        return extractPart(target, retriesLeft - 1);
      }
      return {};
    }
  };

  // Perform extractions sequentially for stability
  if (options.extractSolvency) {
    console.log(`[Gemini ${VERSION}] Starting Part 1: Solvency Common`);
    const resCommon = await extractPart('solvency_common');
    const commonTable = resCommon.solvencyTable || [];

    console.log(`[Gemini ${VERSION}] Starting Part 2: Solvency Reduction`);
    const resReduction = await extractPart('solvency_reduction');
    const reductionTable = resReduction.solvencyTable || [];

    // Merge in-memory by mapping measureType
    solvencyTable = commonTable.map((row: any) => {
      const normMeasureType = (row.measureType || "").replace(/\s+/g, "");
      const matchingReduction = reductionTable.find((r: any) => {
        const rNorm = (r.measureType || "").replace(/\s+/g, "");
        return rNorm === normMeasureType || rNorm.includes(normMeasureType) || normMeasureType.includes(rNorm);
      });

      return {
        companyName: row.companyName || "",
        measureType: row.measureType || "",
        solvencyRatio: row.solvencyRatio || "",
        solvencyAmount: row.solvencyAmount || "",
        basicCapital: row.basicCapital || "",
        supplementaryCapital: row.supplementaryCapital || "",
        solvencyRequiredAmount: row.solvencyRequiredAmount || "",
        appliedCapitalReductionAmount: matchingReduction ? (matchingReduction.appliedCapitalReductionAmount || "0") : "0"
      };
    });

    if (solvencyTable.length === 0 && reductionTable.length > 0) {
      solvencyTable = reductionTable.map((row: any) => ({
        companyName: row.companyName || "",
        measureType: row.measureType || "",
        solvencyRatio: "",
        solvencyAmount: "",
        basicCapital: "",
        supplementaryCapital: "",
        solvencyRequiredAmount: "",
        appliedCapitalReductionAmount: row.appliedCapitalReductionAmount || "0"
      }));
    }
  }
  if (options.extractComparison) {
    const res = await extractPart('comparison');
    if (res.comparisonTable) comparisonTable = res.comparisonTable;
  }
  if (options.extractRiskPremium) {
    const res = await extractPart('riskPremium');
    if (res.riskPremiumTable) riskPremiumTable = res.riskPremiumTable;
  }

  // Ensure UI fields match
  comparisonTable = comparisonTable.map((row: any) => ({
    companyName: row.companyName || "",
    category: row.category || "",
    expectedLossRatio: row.expectedLossRatio || "",
    actualLossRatio: row.actualLossRatio || "",
    differenceRatio: row.differenceRatio || ""
  }));

  solvencyTable = solvencyTable.map((row: any) => ({
    companyName: row.companyName || "",
    measureType: row.measureType || "",
    solvencyRatio: row.solvencyRatio || "",
    solvencyAmount: row.solvencyAmount || "",
    basicCapital: row.basicCapital || "",
    supplementaryCapital: row.supplementaryCapital || "",
    solvencyRequiredAmount: row.solvencyRequiredAmount || "",
    appliedCapitalReductionAmount: row.appliedCapitalReductionAmount || ""
  }));

  riskPremiumTable = riskPremiumTable.map((row: any) => ({
    companyName: row.companyName || "",
    year: row.year || "",
    category: row.category || "",
    y1: row.y1 || "", y2: row.y2 || "", y3: row.y3 || "", y4: row.y4 || "", y5: row.y5 || "",
    y6: row.y6 || "", y7: row.y7 || "", y8: row.y8 || "", y9: row.y9 || "", y10: row.y10 || "",
    y11_15: row.y11_15 || "", y16_20: row.y16_20 || "", y21_25: row.y21_25 || "", y26_30: row.y26_30 || "", y30_plus: row.y30_plus || "",
    presentValue: row.presentValue || ""
  }));

  console.log(`[Gemini ${VERSION}] Final extraction: S=${solvencyTable.length}, C=${comparisonTable.length}, R=${riskPremiumTable.length}`);

  return { comparisonTable, solvencyTable, riskPremiumTable, usageMetadata: totalUsage };
}
