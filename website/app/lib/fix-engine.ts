import { anthropicCallWithRetry } from "../api/scan/fix/route";

export interface FixJob {
  fileContent: string;
  filePath: string;
  issues: string[];
  conventionsHeader?: string;
}

export async function askClaude(job: FixJob): Promise<string> {
  const { fileContent, filePath, issues, conventionsHeader = "" } = job;
  
  const prompt = `${conventionsHeader}You are an expert code fixer for GateTest.
Fix ALL issues. Return ONLY the complete fixed file content.
FILE: ${filePath}
ISSUES: ${issues.join("\n")}
CODE:
${fileContent}`;

  const body = JSON.stringify({
    model: "claude-sonnet-4-20250514",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const res = await anthropicCallWithRetry(body);
  if (res.status === 200) {
    const content = res.data.content as Array<{ type: string; text: string }>;
    return (content?.[0]?.text || "").replace(/^```[\w]*\n?/, "").replace(/\n?```$/, "");
  }
  throw new Error(`Claude error ${res.status}`);
}

export function verifyQuality(fixed: string, filePath: string) {
  const issues: string[] = [];
  const isSource = /\.(js|ts|jsx|tsx)$/i.test(filePath);
  if (!isSource) return { clean: true, newIssues: [] };

  const lines = fixed.split("\n");
  lines.forEach((line, i) => {
    if (/\bconsole\.(log|debug|info)\s*\(/.test(line)) issues.push(`Line ${i + 1}: console.log introduced`);
    if (/^\s*debugger\s*;?$/.test(line)) issues.push(`Line ${i + 1}: debugger introduced`);
    if (/\beval\s*\(/.test(line)) issues.push(`Line ${i + 1}: eval() introduced`);
  });
  return { clean: issues.length === 0, newIssues: issues };
}
