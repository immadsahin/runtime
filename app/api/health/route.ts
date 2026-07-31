import { NextResponse } from "next/server";

import { providerName } from "@/lib/env";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({
    ok: true,
    provider: providerName(),
    time: new Date().toISOString(),
  });
}
