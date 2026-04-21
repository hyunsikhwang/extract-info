import { GoogleGenAI, Type } from "@google/genai";
import { jsonrepair } from "jsonrepair";

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
  const VERSION = "V8-AISTUDIO-SIM";
  
  // Helper to extract a specific part
  const extractPart = async (target: 'solvency' | 'comparison' | 'riskPremium'): Promise<any> => {
    const promptParts: string[] = [];
    let schema: any = {};
    let example: string = "";

    if (target === 'solvency') {
      example = `{ "solvencyTable": [{ "companyName": "회사명", "measureType": "경과조치전", "solvencyRatio": "150.5", "solvencyAmount": "1000", "solvencyRequiredAmount": "800" }] }`;
      promptParts.push(`1. 지급여력비율(K-ICS):
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
- 정보가 존재하지 않는 경우에는 숫자 0 으로 처리`);

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
              solvencyRequiredAmount: { type: Type.STRING },
              appliedCapitalReductionAmount: { type: Type.STRING }
            }
          }
        }
      };
    } else if (target === 'comparison') {
      example = `{ "comparisonTable": [{ "companyName": "회사명", "category": "2024", "expectedLossRatio": "85.2", "actualLossRatio": "88.1", "differenceRatio": "-2.9" }] }`;
      promptParts.push(`4. 보험금 예실차비율:
- 위치: "4-6. 보험계약부채 및 가정 관련 현황" > "최적가정" > "보험금 예실차비율" 테이블
- 항목: 구분(년도), 예상손해율, 실제손해율, 보험금예실차비율
- 최근 연도 데이터 우선, 중복 금지.
- 구분 컬럼에서 "년" 과 공백(whitespace) 제거
- 예상손해율, 실제손해율 컬럼에서 "%" 제거
- 보험금예실차비율 컬럼에서 "%" 제거. 음수를 괄호("()")로 표현한 경우 "-" 표시로 변환해서 일관성 유지`);

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
            }
          }
        }
      };
    } else if (target === 'riskPremium') {
      const yearsRange = "1년, 2년, 3년, 4년, 5년, 6년, 7년, 8년, 9년, 10년, 11년-15년, 16년-20년, 21년-25년, 26년-30년, 30년이후, 현재가치";
      example = `{ "riskPremiumTable": [
        { "companyName": "스위스리", "year": "2025", "category": "예상보험금(A)", "y1": "2337", "presentValue": "13486" },
        { "companyName": "스위스리", "year": "2025", "category": "위험보험료(B)", "y1": "2377", "presentValue": "19218" },
        { "companyName": "스위스리", "year": "2025", "category": "비율(A/B)", "y1": "98.32", "presentValue": "70.17" }
      ] }`;
      promptParts.push(`5. 위험보험료 대비 예상보험금:
- 위치: "② 위험보험료 대비 예상보험금" 테이블
- [구조 인식 특이사항]: 
  * PDF 내에서 "합계", "예상보험금(A)", "위험보험료(B)", "비율(A/B)" 등의 텍스트가 세로로 써있거나 줄바꿈이 심할 수 있습니다 (예: '예\\n상\\n보\\n험\\n금'). 
  * "합계" 섹션의 **경과기간** 컬럼에는 수직으로 3개의 지표가 순서대로 배치되어 있습니다.
- [추출 필수 규칙]:
  1) **무조건 3개 행 추출**: "합계" 바로 옆에 위치한 첫 번째 값들은 "예상보험금(A)", 두 번째 값들은 "위험보험료(B)", 세 번째 값들은 "비율(A/B)" 데이터입니다. 인식된 텍스트와 상관없이 **이 3개 층의 데이터를 각각 별개의 객체로 반드시 생성하십시오.**
  2) **데이터 매핑**: 1년~10년 데이터와 그 오른쪽의 11년~현재가치 데이터를 동일 지표끼리 가로로 합쳐서 하나의 JSON 객체로 만드십시오.
  3) **누락 방지**: "예상보험금"만 추출하고 멈추지 마십시오. "위험보험료"와 "비율" 객체도 반드시 생성해야 통계가 완성됩니다.
  4) **수치**: 모든 문자(쉼표, %, 원 등)를 제거하고 순수 숫자(소수점 포함)만 추출하십시오.`);

      schema = {
        riskPremiumTable: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              companyName: { type: Type.STRING, description: "보험사명 (예: 스위스리아시아)" },
              year: { type: Type.STRING, description: "기준연도 (예: 2025)" },
              category: { type: Type.STRING, description: "구분 (예상보험금(A) 또는 위험보험료(B) 또는 비율(A/B))" },
              y1: { type: Type.STRING, description: "1년 (첫 번째 열 데이터)" },
              y2: { type: Type.STRING }, y3: { type: Type.STRING }, y4: { type: Type.STRING }, y5: { type: Type.STRING },
              y6: { type: Type.STRING }, y7: { type: Type.STRING }, y8: { type: Type.STRING }, y9: { type: Type.STRING }, y10: { type: Type.STRING },
              y11_15: { type: Type.STRING, description: "11년-15년" },
              y16_20: { type: Type.STRING }, y21_25: { type: Type.STRING }, y26_30: { type: Type.STRING }, y30_plus: { type: Type.STRING },
              presentValue: { type: Type.STRING, description: "현재가치 (재계산하지 말고 표에 있는 값 그대로 추출)" }
            }
          }
        }
      };
    }

    const sysInstr = `당신은 보험사 경영공시 PDF에서 데이터를 정밀하게 추출하는 데이터 엔지니어입니다.
반드시 제공된 JSON 스키마를 엄격히 준수하십시오.
### 금지 사항 (Strict Prohibition):
1. 필드 값 내부에 어떠한 설명, 요약, 사족, 또는 문장을 포함하지 마십시오. (예: "~~를 추출했습니다" 금지)
2. JSON 구조 외부나 내부에 텍스트 설명을 붙이지 마십시오.
3. 수치 데이터에서 쉼표(,), 단위(원, %, 년)를 포함하지 마십시오.
4. 모든 응답은 유효한 JSON 형태여야 하며, 데이터가 없으면 빈 문자열("")을 넣으십시오.
위 규칙을 위반할 경우 파이프라인이 파손되므로 절대 엄수하십시오.

권장 예시: ${example}`;

    const userPrompt = `첨부된 PDF의 지정된 위치에서 다음 데이터를 추출하여 JSON으로 반환하십시오:\n${promptParts.join('\n')}`;

    console.log(`[Gemini ${VERSION}] Starting extraction for: ${target}`);

    try {
      const res = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts: [{ text: userPrompt }, { inlineData: { mimeType, data: pdfBase64 } }] }],
        config: {
          systemInstruction: sysInstr,
          temperature: 0,
          maxOutputTokens: 8192,
          responseMimeType: "application/json",
          responseSchema: { type: Type.OBJECT, properties: schema }
        }
      });

      const responseText = res.text;
      if (!responseText) return {};

      const jsonStr = responseText.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ').trim();
      const repairJson = (str: string) => {
        try { return jsonrepair(str); } catch { return str; }
      };
      
      const jsonMatch = jsonStr.match(/```json\s?([\s\S]*?)\s?```/) || jsonStr.match(/{[\s\S]*}/);
      const cleanJson = jsonMatch ? (jsonMatch[1] || jsonMatch[0]) : jsonStr;
      
      return JSON.parse(repairJson(cleanJson));
    } catch (e) {
      console.warn(`[Gemini ${VERSION}] Failed to extract/parse ${target}:`, e);
      return {};
    }
  };

  // Run extractions in parallel for better reliability
  const tasks: Promise<any>[] = [];
  if (options.extractSolvency) tasks.push(extractPart('solvency'));
  if (options.extractComparison) tasks.push(extractPart('comparison'));
  if (options.extractRiskPremium) tasks.push(extractPart('riskPremium'));

  const results = await Promise.all(tasks);
  
  let solvencyTable: any[] = [];
  let comparisonTable: any[] = [];
  let riskPremiumTable: any[] = [];

  results.forEach(res => {
    if (res.solvencyTable) solvencyTable = res.solvencyTable;
    if (res.comparisonTable) comparisonTable = res.comparisonTable;
    if (res.riskPremiumTable) riskPremiumTable = res.riskPremiumTable;
  });

  // Post-processing for consistency
  comparisonTable = comparisonTable.map((row: any) => ({
    companyName: row.companyName || "",
    category: row.category || "",
    expectedLossRatio: row.expectedLossRatio || "",
    actualLossRatio: row.actualLossRatio || "",
    differenceRatio: row.differenceRatio || ""
  }));

  console.log(`[Gemini ${VERSION}] Parallel extraction complete.`);

  return { comparisonTable, solvencyTable, riskPremiumTable };
}
