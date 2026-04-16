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
  options: ExtractionOptions = { extractSolvency: true, extractComparison: true, extractRiskPremium: true }
): Promise<GeminiExtractionResult> {
  // Version tag to verify deployment
  const VERSION = "V8-AISTUDIO-SIM";
  
  const extractionPrompt = `
보험사 경영공시 PDF에서 아래 정보를 추출하여 JSON으로 응답하십시오.

${options.extractSolvency ? `1. 지급여력비율(K-ICS):
- 위치: "5-2. 지급여력비율" > "지급여력비율 내용 및 산출방법 개요" > "지급여력비율 총괄" 테이블
- 대상: 해당 분기(보고서 제출 현재 분기)의 '경과조치 적용 전' 및 '경과조치 적용 후' 세트 1개만 추출
- 항목: 지급여력비율, 지급여력금액, 지급여력기준금액
- 숫자만 추출 ("%"(퍼센트), ","(콤마) 제거). 구분은 "경과조치전", "경과조치후"로 표기.
- 지급여력금액, 지급여력기준 금액은 테이블 우측 상단의 "단위" 를 참고하여 백만원(million)단위로 환산 즉, 단위가 백만원이면 그대로, 단위가 억원이면 "*100" 처리.

2. 지급여력비율 중 기본/보완자본(K-ICS):
- 위치: "5-2. 지급여력비율" > "지급여력비율의 경과조치 적용에 관한 사항" > "공통적용 경과조치 관련" 테이블
- 대상: '경과조치 적용 전' 및 '경과조치 적용 후' 세트 1개만 추출
- 항목: 기본자본, 보완자본
- 숫자만 추출 ("%"(퍼센트), ","(콤마) 제거). 구분은 "경과조치전", "경과조치후"로 표기.
- 기본자본, 보완자본 금액은 테이블 우측 상단의 "단위" 를 참고하여 백만원(million)단위로 표기. 즉, 단위가 백만원이면 그대로, 단위가 억원이면 "*100" 처리.

3. 자본감소분 경과조치 (옵션):
- 위치: "5-2. 지급여력비율" > "지급여력비율의 경과조치 적용에 관한 사항" > "선택적용 경과조치 관련" 테이블
- 항목: 자본감소분 경과조치 적용금액 (경과조치전/경과조치후)
- 숫자만 추출 ("%"(퍼센트), ","(콤마) 제거). 구분은 "경과조치전", "경과조치후"로 표기.
- 자본감소분 경과조치 적용금액은 테이블 우측 상단의 "단위" 를 참고하여 백만원(million)단위로 환산 즉, 단위가 백만원이면 그대로, 단위가 억원이면 "*100" 처리.
- 정보가 존재하지 않는 경우에는 숫자 0 으로 처리
` : ""}

${options.extractComparison ? `4. 보험금 예실차비율:
- 위치: "4-6. 보험계약부채 및 가정 관련 현황" > "최적가정" > "보험금 예실차비율" 테이블
- 항목: 구분(년도), 예상손해율, 실제손해율, 보험금예실차비율
- 최근 연도 데이터 우선, 중복 금지.
- 구분 컬럼에서 "년" 과 공백(whitespace) 제거
- 예상손해율, 실제손해율 컬럼에서 "%" 제거
- 보험금예실차비율 컬럼에서 "%" 제거. 음수를 괄호("()")로 표현한 경우 "-" 표시로 변환해서 일관성 유지
` : ""}

${options.extractRiskPremium ? `5. 위험보험료 대비 예상보험금:
- 위치: "4. 재무에 관한 상황" > "4-6. 보험계약부채 및 가정 관련 현황" > "4) 최적가정" > "② 위험보험료 대비 예상보험금"
- 대상: 표 내에서 "구분" 컬럼이 "합계" 인 행만 추출
- 항목: 회사명, 연도, 경과기간(구분), 1년, 2년, 3년, 4년, 5년, 6년, 7년, 8년, 9년, 10년, 11년-15년, 16년-20년, 21년-25년, 26년-30년, 30년이후, 현재가치
- 주의사항:
  * 1년-10년까지의 기간과, 11년-현재가치의 기간이 두 개의 테이블로 구분되어있는 경우가 있습니다. 그러한 경우에는 single row 로 합쳐주세요.
  * "경과기간" 컬럼은 예상보험금, 위험보험료, 비율 모두 추출해주세요.
  * 2025년, 2024년 모두 추출해주시고, "2025" 또는 "2024" 를 "연도" 컬럼에 입력해주세요.
` : ""}
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
          ...(options.extractSolvency ? {
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
            }
          } : {}),
          ...(options.extractComparison ? {
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
          } : {}),
          ...(options.extractRiskPremium ? {
            riskPremiumTable: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  companyName: { type: Type.STRING },
                  year: { type: Type.STRING },
                  category: { type: Type.STRING },
                  y1: { type: Type.STRING },
                  y2: { type: Type.STRING },
                  y3: { type: Type.STRING },
                  y4: { type: Type.STRING },
                  y5: { type: Type.STRING },
                  y6: { type: Type.STRING },
                  y7: { type: Type.STRING },
                  y8: { type: Type.STRING },
                  y9: { type: Type.STRING },
                  y10: { type: Type.STRING },
                  y11_15: { type: Type.STRING },
                  y16_20: { type: Type.STRING },
                  y21_25: { type: Type.STRING },
                  y26_30: { type: Type.STRING },
                  y30_plus: { type: Type.STRING },
                  presentValue: { type: Type.STRING }
                }
              }
            }
          } : {})
        }
      }
    },
  });

  const responseText = response.text;
  if (!responseText) {
    console.error(`[Gemini ${VERSION}] Empty response received`);
    return { comparisonTable: [], solvencyTable: [], riskPremiumTable: [] };
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
    let riskPremiumTable = parsed.riskPremiumTable || [];

    // Robust handling for direct array responses
    if (Array.isArray(parsed)) {
      if (parsed.length > 0 && ('solvencyRatio' in parsed[0] || 'measureType' in parsed[0])) {
        solvencyTable = parsed;
      } else if (parsed.length > 0 && ('y1' in parsed[0] || 'presentValue' in parsed[0])) {
        riskPremiumTable = parsed;
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

    console.log(`[Gemini ${VERSION}] Summary: Comparison(${comparisonTable.length}), Solvency(${solvencyTable.length}), RiskPremium(${riskPremiumTable.length})`);

    return {
      comparisonTable,
      solvencyTable,
      riskPremiumTable,
      usageMetadata: response.usageMetadata ? {
        promptTokenCount: response.usageMetadata.promptTokenCount,
        candidatesTokenCount: response.usageMetadata.candidatesTokenCount,
        totalTokenCount: response.usageMetadata.totalTokenCount,
      } : undefined
    };
  } catch (e) {
    console.error(`[Gemini ${VERSION}] JSON Parse Error:`, e);
    return { comparisonTable: [], solvencyTable: [], riskPremiumTable: [] };
  }
}
