import { errorToResponse } from "@/src/server/http/errors";
import {
  createChannel,
  listChannelRecords,
} from "@/src/server/services/channels";
import { requireWebRequest } from "@/src/server/services/webAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Web admin routes require the startup Web access key session.
// Channels are automatic routing units; there is no active credential selection.
export async function GET(request: Request) {
  try {
    requireWebRequest(request);
    return Response.json(listChannelRecords());
  } catch (error) {
    return errorToResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireWebRequest(request);
    const body = await request.json();
    return Response.json(createChannel(body), { status: 201 });
  } catch (error) {
    return errorToResponse(error);
  }
}
