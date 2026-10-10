import { readFileSync } from "node:fs";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config.js";
import type { ReportResult } from "../graph/state.js";

const SIGNED_URL_TTL_SECONDS = 7 * 24 * 60 * 60; // SigV4 maximum

function tigrisConfigured(): boolean {
  return Boolean(config.TIGRIS_BUCKET && config.TIGRIS_ACCESS_KEY_ID && config.TIGRIS_SECRET_ACCESS_KEY);
}

function client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: config.TIGRIS_ENDPOINT,
    credentials: {
      accessKeyId: config.TIGRIS_ACCESS_KEY_ID!,
      secretAccessKey: config.TIGRIS_SECRET_ACCESS_KEY!,
    },
  });
}

/** Signs a download link for a stored report reference (`s3://bucket/key`). */
export async function signReportUrl(storageRef: string, ttlSeconds = SIGNED_URL_TTL_SECONDS): Promise<string> {
  const match = storageRef.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match) throw new Error(`not an object storage reference: ${storageRef}`);
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: match[1], Key: match[2] }), { expiresIn: ttlSeconds });
}

/**
 * Uploads the report to the Tigris bucket when configured and returns a signed
 * link; otherwise leaves it in the local reports directory.
 * `path` is the durable reference saved on the run; `url` is what alerts link to.
 */
export async function storeReport(localPath: string, runId: number): Promise<ReportResult> {
  if (!tigrisConfigured()) return { url: localPath, path: localPath };

  const ext = path.extname(localPath);
  const key = `reports/run-${runId}${ext}`;
  await client().send(
    new PutObjectCommand({
      Bucket: config.TIGRIS_BUCKET,
      Key: key,
      Body: readFileSync(localPath),
      ContentType: ext === ".pdf" ? "application/pdf" : "text/html; charset=utf-8",
    }),
  );
  const storageRef = `s3://${config.TIGRIS_BUCKET}/${key}`;
  return { url: await signReportUrl(storageRef), path: storageRef };
}
