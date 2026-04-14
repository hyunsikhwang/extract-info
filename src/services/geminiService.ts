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
보험사 경영공시 PDF에서 다음 정보를 추출하여 JSON으로 응답하십시오.

1. 지급여력비율(K-ICS):
[필수]
- 위치: "5-2. 지급여력비율" > "지급여력비율의 경과조치 적용에 관한 사항" > "공통적용 경과조치 관련" 내 테이블
- 대상 구분: '경과조치 적용 전' 및 '경과조치 적용 후'
- 항목: 지급여력비율, 지급여력금액, 기본자본, 보완자본, 지급여력기준금액
- "%", "," 등의 특수문자는 삭제. 경과조치 적용전/후는 "전", "후" 로만 구분 표기
- **중요: 동일한 항목이 여러 번 나타나더라도 가장 정확한 하나의 세트(전/후 각 1개씩)만 추출하십시오. 중복 추출은 절대로 금지합니다.**

[옵션] 아래 위치의 테이블이 존재하는 경우에만 추출
- 위치: "5-2. 지급여력비율" > "지급여력비율의 경과조치 적용에 관한 사항" > "선택적용 경과조치 관련" 내 테이블
- 대상 구분: '경과조치 적용 전' 및 '경과조치 적용 후'
- 항목: 자본감소분 경과조치 적용금액
- "장수위험·사업비위험·해지위험 및 대재해위험 경과조치" 내의 테이블 값을 절대로 추출하지 않음
- 값이 존재하지 않으면 공란(blank)으로 반환

2. 보험금 예실차비율:
- 위치: "4-6. 보험계약부채 및 가정 관련 현황" > "최적가정" > "보험금 예실차비율" 내 테이블
- 항목: 구분(년도), 예상손해율, 실제손해율, 보험금예실차비율
- 구분(년도) 컬럼 값의 "년" 은 삭제
- **중요: 최근 연도 데이터를 우선하여 추출하되, 중복된 행이 생성되지 않도록 주의하십시오.**
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
