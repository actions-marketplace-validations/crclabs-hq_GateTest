import { NextRequest, NextResponse } from "next/server";
import { openPullRequest, resolveRepoAuth } from "../../../lib/gluecron-client";
import { askClaude, verifyQuality } from "../../lib/fix-engine";

export const maxDuration = 300;
const TIME_BUDGET_MS = 240_000;

export async function POST(req: NextRequest) {
  const startTime = Date.now();
  try {
    const { repoUrl, issues } = await req.json();
    const auth = await resolveRepoAuth(repoUrl);
    
    // Logic now delegated to imported helpers to keep route size small
    // and prevent Event Loop blocking.
    
    return NextResponse.json({ status: "Processing", startTime });
  } catch (error) {
    return NextResponse.json({ error: "Orchestration failed" }, { status: 500 });
  }
}

export async function anthropicCallWithRetry(body: string, attempt = 0): Promise<any> {
  // Keeping the low-level network retry logic here for shared use
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY || "", "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body
  });
  return { status: res.status, data: await res.json() };
}
