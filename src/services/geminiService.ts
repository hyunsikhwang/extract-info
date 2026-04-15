import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

export async function extractTablesWithGemini(pdfBase64: string, mimeType: string = 'application/pdf'): Promise<GeminiExtractionResult> {
  // Version tag to verify deployment
  const VERSION = "V8-AISTUDIO-SIM";
  
  const extractionPrompt = `
보험사 경영공시 PDF에서 아래 정보를 추출하여 JSON으로 응답하십시오.

1. 지급여력비율(K-ICS):
- 위치: "5-2. 지급여력비율" > "지급여력비율의 경과조치 적용에 관한 사항" > "공통적용 경과조치 관련" 테이블
- 대상: '경과조치 적용 전' 및 '경과조치 적용 후' 세트 1개만 추출
- 항목: 지급여력비율, 지급여력금액, 기본자본, 보완자본, 지급여력기준금액
- 숫자만 추출 ("%"(퍼센트), ","(콤마) 제거). 구분은 "전", "후"로 표기.

2. 자본감소분 경과조치 (옵션):
- 위치: "5-2. 지급여력비율" > "지급여력비율의 경과조치 적용에 관한 사항" > "선택적용 경과조치 관련" 테이블
- 항목: 자본감소분 경과조치 적용금액 (전/후)

3. 보험금 예실차비율:
- 위치: "4-6. 보험계약부채 및 가정 관련 현황" > "최적가정" > "보험금 예실차비율" 테이블
- 항목: 구분(년도), 예상손해율, 실제손해율, 보험금예실차비율
- 최근 연도 데이터 우선, 중복 금지.
- 구분 컬럼에서 "년" 과 공백(whitespace) 제거
- 보험금예실차비율 컬럼에서 "%" 제거. 음수를 괄호("()")로 표현한 경우 "-" 표시로 변환해서 일관성 유지
`;

  console.log(`[Gemini ${VERSION}] Calling API with model: gemini-3-flash-preview, PDF size: ${(pdfBase64.length * 0.75 / 1024).toFixed(2)} KB`);
  
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType,
              data: pdfBase64,
            },
          },
          { text: extractionPrompt },
        ],
      },
    ],
    config: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
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
                solvencyRequiredAmount: { type: Type.STRING },
                appliedCapitalReductionAmount: { type: Type.STRING }
              }
            }
          },
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
              }
            }
          }
        }
      }
    },
  });

  const responseText = response.text;
  if (!responseText) {
    console.error(`[Gemini ${VERSION}] Empty response received`);
    return { comparisonTable: [], solvencyTable: [] };
  }

  console.log(`[Gemini ${VERSION}] Raw Response:`, responseText);

  try {
    // Extract JSON from potential markdown blocks or raw text
    let jsonStr = responseText.trim();
    const jsonMatch = responseText.match(/```json\s?([\s\S]*?)\s?```/) || responseText.match(/{[\s\S]*}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1] || jsonMatch[0];
    }

    const parsed = JSON.parse(jsonStr);
    
    let comparisonTable = parsed.comparisonTable || [];
    let solvencyTable = parsed.solvencyTable || [];

    // Robust handling for direct array responses
    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && ('solvencyRatio' in parsed[0] || 'measureType' in parsed[0])) {
        solvencyTable = parsed;
      } else {
        comparisonTable = parsed;
      }
    }

    // Fix common hallucinations in field names
    comparisonTable = comparisonTable.map((row: any) => ({
      companyName: row.companyName || "",
      category: row.category || row.measureType || "",
      expectedLossRatio: row.expectedLossRatio || "",
      actualLossRatio: row.actualLossRatio || "",
      differenceRatio: row.differenceRatio || row.lossRatioDifference || ""
    }));

    console.log(`[Gemini ${VERSION}] Summary: Comparison(${comparisonTable.length}), Solvency(${solvencyTable.length})`);

    return {
      comparisonTable,
      solvencyTable,
      usageMetadata: response.usageMetadata ? {
        promptTokenCount: response.usageMetadata.promptTokenCount,
        candidatesTokenCount: response.usageMetadata.candidatesTokenCount,
        totalTokenCount: response.usageMetadata.totalTokenCount,
      } : undefined
    };
  } catch (e) {
    console.error(`[Gemini ${VERSION}] JSON Parse Error:`, e);
    return { comparisonTable: [], solvencyTable: [] };
  }
}
