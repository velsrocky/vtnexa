import { invoke } from "@tauri-apps/api/core";
import type { Approval } from "./approval";

function approvalArgs(a?: Approval): { approvalToken: string | null; approvalDetail: string | null } {
  return { approvalToken: a?.token ?? null, approvalDetail: a?.detail ?? null };
}

export interface BrowserElement {
  ref: number;
  tag: string;
  name: string;
  href?: string;
  inputType?: string;
  value?: string;
}

export interface BrowserSnapshot {
  ok: boolean;
  url: string;
  title: string;
  text: string;
  elements: BrowserElement[];
}

export interface BrowserRuntimeStatus {
  ready: boolean;
  source?: string | null;
  path?: string | null;
  version?: string | null;
}

export interface BrowserEngineStatus {
  ready: boolean;
  engine: string;
  channel?: string | null;
  path?: string | null;
  source?: string | null;
  error?: string;
  remediation?: string;
}

export interface BrowserStatus {
  ok?: boolean;
  ready?: boolean;
  running?: boolean;
  headless?: boolean;
  baseUrl?: string | null;
  port?: number | null;
  pageUrl?: string | null;
  blockedTarget?: string | null;
  profilePath?: string | null;
  runtime?: BrowserRuntimeStatus;
  node?: BrowserRuntimeStatus;
  browser?: BrowserEngineStatus;
  missing?: string[];
  remediation?: string[];
  error?: string;
}

let browserPort = 0;

function setPortIfValid(port: number | null | undefined) {
  if (typeof port === "number" && Number.isInteger(port) && port > 0 && port <= 65535) {
    browserPort = port;
  }
}

function portFromSidecarUrl(baseUrl: string | null | undefined): number | null {
  if (!baseUrl) return null;
  try {
    const parsed = new URL(baseUrl);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

function adoptStatusPort(status: BrowserStatus | null | undefined) {
  if (!status) return;
  setPortIfValid(status.port ?? portFromSidecarUrl(status.baseUrl));
}

export function setBrowserPort(port: number) {
  setPortIfValid(port);
}

export function getBrowserPort(): number {
  return browserPort;
}

export async function browserPreflight(): Promise<BrowserStatus> {
  return invoke<BrowserStatus>("browser_preflight", {});
}

export async function browserStart(headless = false): Promise<BrowserStatus> {
  const status = await browserStatus();
  if (status.running) {
    adoptStatusPort(status);
    return { ...status, ok: true };
  }
  const result = await invoke<BrowserStatus>("browser_start", { headless });
  adoptStatusPort(result);
  return result ?? { ok: false, error: "browser_start returned no status; choose Recheck" };
}

export async function browserStop(): Promise<unknown> {
  return invoke("browser_stop", {});
}

export async function browserStatus(): Promise<BrowserStatus> {
  return invoke<BrowserStatus>("browser_status", {});
}

export async function browserNavigate(url: string, approval?: Approval): Promise<{ url?: string; pageUrl?: string; title?: string }> {
  return invoke("browser_navigate", { url, ...approvalArgs(approval) });
}

export async function browserSnapshot(): Promise<BrowserSnapshot> {
  return invoke<BrowserSnapshot>("browser_snapshot", {});
}

export async function browserClick(target_ref: number, approval?: Approval): Promise<unknown> {
  return invoke("browser_click", { targetRef: target_ref, ...approvalArgs(approval) });
}

export async function browserType(
  target_ref: number,
  text: string,
  submit = false,
  approval?: Approval,
): Promise<unknown> {
  return invoke("browser_type", { targetRef: target_ref, text, submit, ...approvalArgs(approval) });
}

export async function browserScreenshot(): Promise<{
  imageBase64?: string;
  mimeType?: string;
  url?: string;
  pageUrl?: string;
}> {
  return invoke("browser_screenshot", {});
}

export async function browserScroll(dx = 0, dy = 600): Promise<unknown> {
  return invoke("browser_scroll", { dx, dy });
}

export async function browserBack(approval?: Approval): Promise<unknown> {
  return invoke("browser_back", { ...approvalArgs(approval) });
}
