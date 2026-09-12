import { invoke } from "@tauri-apps/api/core";

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

export async function browserStart(port = 39317, headless = false): Promise<unknown> {
  return invoke("browser_start", { port, headless });
}

export async function browserStop(): Promise<unknown> {
  return invoke("browser_stop", {});
}

export async function browserStatus(): Promise<{ running?: boolean; url?: string }> {
  return invoke("browser_status", {});
}

export async function browserNavigate(url: string): Promise<{ url?: string; title?: string }> {
  return invoke("browser_navigate", { url });
}

export async function browserSnapshot(): Promise<BrowserSnapshot> {
  return invoke("browser_snapshot", {});
}

export async function browserClick(target_ref: number): Promise<unknown> {
  return invoke("browser_click", { target_ref });
}

export async function browserType(target_ref: number, text: string, submit = false): Promise<unknown> {
  return invoke("browser_type", { target_ref, text, submit });
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

export async function browserBack(): Promise<unknown> {
  return invoke("browser_back", {});
}
