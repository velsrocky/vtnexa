import { invoke } from "@tauri-apps/api/core";
import type { Approval } from "./approval";

function approvalArgs(a?: Approval): { approval_token: string | null; approval_detail: string | null } {
  return { approval_token: a?.token ?? null, approval_detail: a?.detail ?? null };
}

export interface BrowserElement {
  ref: number;
  tag: string;
  name: string;
  href?: string;
  inputType?: string;
}

export interface BrowserSnapshot {
  ok: boolean;
  url: string;
  title: string;
  text: string;
  elements: BrowserElement[];
}

let browserPort = 39317;

export function setBrowserPort(port: number) {
  browserPort = port;
}

export function getBrowserPort(): number {
  return browserPort;
}

export async function browserStart(headless = false): Promise<{ ok?: boolean; baseUrl?: string; error?: string }> {
  const result = await browserStatus();
  if (result.running) {
    setBrowserPort(parseInt(result.url?.split(':')[2] || '39317', 10));
    return { ok: true, baseUrl: result.url };
  }
  const r = (await invoke("browser_start", { port: browserPort, headless })) as { ok?: boolean; baseUrl?: string; error?: string } | null;
  if (r?.baseUrl) {
    const parsedPort = parseInt(r.baseUrl.split(':')[2] || '39317', 10);
    if (!Number.isNaN(parsedPort)) setBrowserPort(parsedPort);
  }
  return r || { ok: false, error: "unknown error" };
}

export async function browserStop(): Promise<unknown> {
  return invoke("browser_stop", {});
}

export async function browserStatus(): Promise<{ running?: boolean; url?: string }> {
  return invoke("browser_status", {});
}

export async function browserNavigate(url: string, approval?: Approval): Promise<{ url?: string; title?: string }> {
  return invoke("browser_navigate", { url, ...approvalArgs(approval) });
}

export async function browserSnapshot(): Promise<BrowserSnapshot> {
  return invoke("browser_snapshot", {});
}

export async function browserClick(target_ref: number, approval?: Approval): Promise<unknown> {
  return invoke("browser_click", { target_ref, ...approvalArgs(approval) });
}

export async function browserType(
  target_ref: number,
  text: string,
  submit = false,
  approval?: Approval,
): Promise<unknown> {
  return invoke("browser_type", { target_ref, text, submit, ...approvalArgs(approval) });
}

export async function browserScreenshot(): Promise<{
  imageBase64?: string;
  mimeType?: string;
  url?: string;
}> {
  return invoke("browser_screenshot", {});
}

export async function browserScroll(dx = 0, dy = 600): Promise<unknown> {
  return invoke("browser_scroll", { dx, dy });
}

export async function browserBack(approval?: Approval): Promise<unknown> {
  return invoke("browser_back", { ...approvalArgs(approval) });
}
