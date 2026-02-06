/**
 * NEO WORKER v4.0 - Hot Session Architecture
 *
 * ENDPOINTS:
 * - POST /prepare-session - подготвя hot session (извиква се от crawler)
 * - POST /execute - изпълнява действие (извиква се от neo-agent-core)
 * - POST /interact - legacy endpoint за backwards compatibility
 * - POST /relay/crawl - RELAY към browser crawler (извиква се от Supabase Edge)
 */

import { chromium, Browser, Page, BrowserContext } from "playwright";
import express, { Request, Response } from "express";

const PORT = parseInt(process.env.PORT || "3000");

// Auth for worker endpoints (called by Supabase Edge / agent-core)
const WORKER_SECRET = process.env.NEO_WORKER_SECRET || "change-me-in-production";

// Relay target (Render crawler)
const CRAWLER_BASE_URL = (process.env.BROWSER_CRAWLER_URL || "https://neo-browser-crawler-w7am.onrender.com").replace(
  /\/+$/,
  ""
);
const CRAWLER_SECRET = process.env.CRAWLER_SECRET || ""; // neo_super_secret_2026

interface SiteMapButton {
  text: string;
  selector: string;
  keywords: string[];
  action_type: "booking" | "contact" | "navigation" | "submit" | "other";
}

interface SiteMapField {
  name: string;
  selector: string;
  type: "date" | "number" | "text" | "select";
  keywords: string[];
}

interface SiteMapForm {
  selector: string;
  fields: SiteMapField[];
  submit_button: string;
}

interface SiteMap {
  site_id: string;
  url: string;
  buttons: SiteMapButton[];
  forms: SiteMapForm[];
  prices: Array<{ text: string; context: string }>;
}

interface HotSession {
  page: Page;
  context: BrowserContext;
  siteMap: SiteMap;
  lastActivity: number;
  currentUrl: string;
}

interface ExecuteRequest {
  site_id: string;
  keywords: string[];
  data?: {
    check_in?: string;
    check_out?: string;
    guests?: number;
  };
}

// Legacy interface for backwards compatibility
interface InteractRequest {
  site_url: string;
  user_message: string;
  session_id: string;
  conversation_history: Array<{ role: string; content: string }>;
  booking_data?: {
    check_in?: string;
    check_out?: string;
    guests?: number;
  };
}

const PATTERNS = {
  booking: ["резерв", "book", "запази", "наличност", "свободн", "availability", "reserve", "нощувк"],
  check_in: ["от", "check-in", "checkin", "настаняване", "пристигане", "arrival", "from", "start"],
  check_out: ["до", "check-out", "checkout", "напускане", "заминаване", "departure", "to", "end"],
  guests: ["човека", "души", "гости", "guests", "adults", "persons", "двама", "трима", "възрастни", "брой"],
  prices: ["цена", "цени", "price", "струва", "колко", "cost", "rate", "тариф"],
  contact: ["контакт", "contact", "свържи", "обади", "телефон", "имейл", "email"],
  search: ["търси", "search", "find", "провери", "check", "покажи", "show"],
  rooms: ["стая", "стаи", "room", "rooms", "апартамент", "suite", "настаняване"],
};

class HotSessionManager {
  private browser: Browser | null = null;
  private sessions: Map<string, HotSession> = new Map();
  private isReady = false;

  private readonly MAX_SESSIONS = 50;
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000;
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000;

  async start(): Promise<void> {
    console.log("[WORKER] Starting browser...");

    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });

    this.isReady = true;
    setInterval(() => this.cleanupSessions(), this.CLEANUP_INTERVAL);

    console.log("[WORKER] ✓ Ready!");
  }

  async prepareSession(siteId: string, siteMap: SiteMap): Promise<boolean> {
    if (!this.isReady || !this.browser) {
      console.error("[PREPARE] Browser not ready");
      return false;
    }

    const startTime = Date.now();
    console.log(`[PREPARE] Site: ${siteId}`);
    console.log(`[PREPARE] URL: ${siteMap.url}`);
    console.log(
      `[PREPARE] Buttons: ${siteMap.buttons?.length || 0}, Forms: ${siteMap.forms?.length || 0}, Prices: ${
        siteMap.prices?.length || 0
      }`
    );

    try {
      await this.closeSession(siteId);

      if (this.sessions.size >= this.MAX_SESSIONS) {
        this.evictOldestSession();
      }

      const context = await this.browser.newContext({
        viewport: { width: 1366, height: 768 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
        locale: "bg-BG",
        timezoneId: "Europe/Sofia",
        ignoreHTTPSErrors: true,
      });

      const page = await context.newPage();

      let url = siteMap.url;
      if (!url.startsWith("http")) url = "https://" + url;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1500);

      this.sessions.set(siteId, {
        page,
        context,
        siteMap,
        lastActivity: Date.now(),
        currentUrl: page.url(),
      });

      const elapsed = Date.now() - startTime;
      console.log(`[PREPARE] ✓ Session ready in ${elapsed}ms`);
      return true;
    } catch (error) {
      console.error(`[PREPARE] ✗ Failed:`, error);
      return false;
    }
  }

  async execute(
    request: ExecuteRequest
  ): Promise<{
    success: boolean;
    message: string;
    observation?: Record<string, unknown>;
  }> {
    const { site_id, keywords, data } = request;
    const session = this.sessions.get(site_id);

    if (!session) {
      console.log(`[EXECUTE] No session for ${site_id}`);
      return { success: false, message: "Няма активна сесия. Моля, изчакайте зареждане." };
    }

    const startTime = Date.now();
    session.lastActivity = Date.now();

    console.log(`[EXECUTE] Site: ${site_id}`);
    console.log(`[EXECUTE] Keywords: ${keywords.slice(0, 5).join(", ")}`);
    if (data) console.log(`[EXECUTE] Data:`, data);

    try {
      try {
        await session.page.evaluate(() => true);
      } catch {
        console.log(`[EXECUTE] Page closed, recreating...`);
        await this.prepareSession(site_id, session.siteMap);
        const newSession = this.sessions.get(site_id);
        if (!newSession) return { success: false, message: "Грешка при възстановяване на сесията" };
      }

      const action = this.matchAction(keywords, session.siteMap, data);
      console.log(`[EXECUTE] Action: ${action.type}`);

      let result: { message: string; observation?: Record<string, unknown> };

      switch (action.type) {
        case "fill_form":
          result = await this.fillForm(session.page, action.form!, action.data!);
          break;
        case "click":
          result = await this.clickButton(session.page, action.selector!, action.buttonText);
          break;
        case "return_prices":
          result = { message: this.formatPrices(session.siteMap.prices), observation: { prices: session.siteMap.prices } };
          break;
        case "return_contact":
          result = await this.getContactInfo(session.page);
          break;
        case "navigate":
          result = await this.navigateTo(session.page, action.url!);
          break;
        case "observe":
        default:
          result = await this.observeCurrentState(session.page);
          break;
      }

      const elapsed = Date.now() - startTime;
      console.log(`[EXECUTE] ✓ Done in ${elapsed}ms: ${result.message.slice(0, 50)}`);
      return { success: true, ...result };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[EXECUTE] ✗ Error:`, errMsg);
      return { success: false, message: "Грешка при изпълнение" };
    }
  }

  async interact(
    request: InteractRequest
  ): Promise<{
    success: boolean;
    message: string;
    observation?: Record<string, unknown>;
    action_taken?: string;
    logs: string[];
  }> {
    const logs: string[] = [];
    const { site_url, user_message, session_id, booking_data } = request;

    logs.push(`[LEGACY] Session: ${session_id}`);

    let session = this.sessions.get(session_id);

    if (!session) {
      logs.push(`[LEGACY] No hot session, creating...`);

      if (!this.browser) return { success: false, message: "Worker не е готов", logs };

      try {
        const context = await this.browser.newContext({
          viewport: { width: 1366, height: 768 },
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0 Safari/537.36",
          locale: "bg-BG",
          timezoneId: "Europe/Sofia",
          ignoreHTTPSErrors: true,
        });

        const page = await context.newPage();

        let url = site_url;
        if (url && !url.startsWith("http")) url = "https://" + url;

        if (url) {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForTimeout(1500);
        }

        const observation = await this.observeDOM(page);

        const siteMap: SiteMap = {
          site_id: session_id,
          url: site_url,
          buttons: observation.buttons.map((b) => ({
            text: b.text,
            selector: b.selector,
            keywords: b.text.toLowerCase().split(/\s+/),
            action_type: this.detectButtonType(b.text),
          })),
          forms: [],
          prices: observation.prices.map((p) => ({ text: p, context: "" })),
        };

        session = { page, context, siteMap, lastActivity: Date.now(), currentUrl: page.url() };
        this.sessions.set(session_id, session);
        logs.push(`[LEGACY] Session created`);
      } catch (error) {
        logs.push(`[LEGACY] Failed to create session: ${error}`);
        return { success: false, message: "Грешка при свързване със сайта", logs };
      }
    }

    const keywords = user_message
      .toLowerCase()
      .replace(/[,.!?;:()[\]{}""'']/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const result = await this.execute({ site_id: session_id, keywords, data: booking_data });
    logs.push(`[LEGACY] Result: ${result.success ? "success" : "failed"}`);

    return {
      success: result.success,
      message: result.message,
      observation: result.observation,
      action_taken: result.success ? result.message : undefined,
      logs,
    };
  }

  private matchAction(
    keywords: string[],
    siteMap: SiteMap,
    data?: ExecuteRequest["data"]
  ): {
    type: "fill_form" | "click" | "return_prices" | "return_contact" | "navigate" | "observe";
    form?: SiteMapForm;
    selector?: string;
    buttonText?: string;
    url?: string;
    data?: Record<string, unknown>;
  } {
    const joined = keywords.join(" ").toLowerCase();

    const hasBookingKeyword = PATTERNS.booking.some((p) => joined.includes(p));
    const hasDates = data?.check_in || data?.check_out;

    if (hasBookingKeyword || hasDates) {
      const form = siteMap.forms?.find((f) =>
        f.fields?.some(
          (field) =>
            field.type === "date" ||
            PATTERNS.check_in.some((k) => field.keywords?.includes(k)) ||
            PATTERNS.check_out.some((k) => field.keywords?.includes(k))
        )
      );

      if (form) return { type: "fill_form", form, data };

      const bookBtn = siteMap.buttons?.find(
        (b) => b.action_type === "booking" || PATTERNS.booking.some((p) => b.text.toLowerCase().includes(p))
      );

      if (bookBtn) return { type: "click", selector: bookBtn.selector, buttonText: bookBtn.text };
    }

    if (PATTERNS.prices.some((p) => joined.includes(p))) {
      if (siteMap.prices && siteMap.prices.length > 0) return { type: "return_prices" };
    }

    if (PATTERNS.contact.some((p) => joined.includes(p))) {
      const contactBtn = siteMap.buttons?.find(
        (b) => b.action_type === "contact" || PATTERNS.contact.some((p) => b.text.toLowerCase().includes(p))
      );
      if (contactBtn) return { type: "click", selector: contactBtn.selector, buttonText: contactBtn.text };
      return { type: "return_contact" };
    }

    if (PATTERNS.rooms.some((p) => joined.includes(p))) {
      const roomsBtn = siteMap.buttons?.find((b) => PATTERNS.rooms.some((p) => b.text.toLowerCase().includes(p)));
      if (roomsBtn) return { type: "click", selector: roomsBtn.selector, buttonText: roomsBtn.text };
    }

    if (PATTERNS.search.some((p) => joined.includes(p))) {
      const searchBtn = siteMap.buttons?.find(
        (b) => b.action_type === "submit" || PATTERNS.search.some((p) => b.text.toLowerCase().includes(p))
      );
      if (searchBtn) return { type: "click", selector: searchBtn.selector, buttonText: searchBtn.text };
    }

    if (siteMap.buttons) {
      for (const btn of siteMap.buttons) {
        const btnKeywords = btn.keywords?.map((k) => k.toLowerCase()) || [];
        if (keywords.some((kw) => btnKeywords.includes(kw.toLowerCase()))) {
          return { type: "click", selector: btn.selector, buttonText: btn.text };
        }
      }
    }

    return { type: "observe" };
  }

  private async fillForm(page: Page, form: SiteMapForm, data: Record<string, unknown>) {
    const actions: string[] = [];
    if (!form.fields) return { message: "Формата няма полета" };

    for (const field of form.fields) {
      let value: string | undefined;
      const fieldKeywords = field.keywords?.map((k) => k.toLowerCase()) || [];

      if (PATTERNS.check_in.some((k) => fieldKeywords.includes(k)) && (data as any).check_in) value = String((data as any).check_in);
      else if (PATTERNS.check_out.some((k) => fieldKeywords.includes(k)) && (data as any).check_out) value = String((data as any).check_out);
      else if (PATTERNS.guests.some((k) => fieldKeywords.includes(k)) && (data as any).guests) value = String((data as any).guests);

      if (value) {
        try {
          const selectors = [field.selector, `[name="${field.name}"]`, `#${field.name}`].filter(Boolean);
          let filled = false;

          for (const sel of selectors) {
            try {
              const el = await page.$(sel);
              if (el) {
                if (field.type === "select") await page.selectOption(sel, value, { timeout: 2000 });
                else await page.fill(sel, value, { timeout: 2000 });
                filled = true;
                break;
              }
            } catch {}
          }

          if (filled) {
            const fieldLabel = field.name.replace(/[-_]/g, " ");
            actions.push(`${fieldLabel}: ${value}`);
          }
        } catch (e) {
          console.log(`[FILL] Could not fill ${field.name}:`, e);
        }
      }
    }

    if (form.submit_button && actions.length > 0) {
      try {
        await page.click(form.submit_button, { timeout: 3000 });
        await page.waitForTimeout(1500);
        actions.push("Търсене");
      } catch (e) {
        console.log(`[FILL] Could not click submit:`, e);
      }
    }

    const observation = await this.quickObserve(page);
    return { message: actions.length > 0 ? `Попълних: ${actions.join(", ")}` : "Не успях да попълня формата", observation };
  }

  private async clickButton(page: Page, selector: string, buttonText?: string) {
    try {
      const strategies = [
        async () => await page.click(selector, { timeout: 2000 }),
        async () => buttonText && (await page.click(`text="${buttonText}"`, { timeout: 2000 })),
        async () => buttonText && (await page.click(`button:has-text("${buttonText}")`, { timeout: 2000 })),
        async () => buttonText && (await page.click(`a:has-text("${buttonText}")`, { timeout: 2000 })),
      ];

      for (const strategy of strategies) {
        try {
          await strategy();
          await page.waitForTimeout(1000);
          const observation = await this.quickObserve(page);
          return { message: buttonText ? `Кликнах "${buttonText}"` : "Кликнах", observation };
        } catch {}
      }

      return { message: "Не успях да кликна" };
    } catch {
      return { message: "Не успях да кликна" };
    }
  }

  private formatPrices(prices: SiteMap["prices"]) {
    if (!prices || prices.length === 0) return "Не намерих цени на сайта";
    const formatted = prices.slice(0, 5).map((p) => (p.context ? `${p.context}: ${p.text}` : p.text)).join("; ");
    return `Цени: ${formatted}`;
  }

  private async getContactInfo(page: Page) {
    try {
      const contact = await page.evaluate(() => {
        const text = document.body.innerText;
        const phonePatterns = [/(\+359|0)[\s-]?\d{2,3}[\s-]?\d{3}[\s-]?\d{3}/g, /(\+359|0)\d{9}/g];

        let phone = null;
        for (const pattern of phonePatterns) {
          const match = text.match(pattern);
          if (match) { phone = match[0]; break; }
        }

        const email = text.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0];
        return { phone, email };
      });

      const parts: string[] = [];
      if ((contact as any).phone) parts.push(`Телефон: ${(contact as any).phone}`);
      if ((contact as any).email) parts.push(`Email: ${(contact as any).email}`);

      return { message: parts.length > 0 ? parts.join(". ") : "Не намерих контактна информация на тази страница" };
    } catch {
      return { message: "Не успях да извлека контактите" };
    }
  }

  private async navigateTo(page: Page, url: string) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
      await page.waitForTimeout(1000);
      const observation = await this.quickObserve(page);
      return { message: `Отворих ${url}`, observation };
    } catch {
      return { message: "Не успях да отворя страницата" };
    }
  }

  private async observeCurrentState(page: Page) {
    const observation = await this.quickObserve(page);

    let message = `Страница: "${(observation as any).title}"`;
    if ((observation as any).hasAvailability) message += ". Виждам информация за наличност.";
    if ((observation as any).prices && ((observation as any).prices as string[]).length > 0) {
      message += `. Цени: ${((observation as any).prices as string[]).slice(0, 3).join(", ")}`;
    }

    return { message, observation };
  }

  private async quickObserve(page: Page): Promise<Record<string, unknown>> {
    try {
      return await page.evaluate(() => {
        const text = document.body.innerText.slice(0, 1000);
        const priceMatches = [...text.matchAll(/(\d+[\s,.]?\d*)\s*(лв\.?|BGN|EUR|€)/gi)];
        const prices = priceMatches.map((m) => m[0]).slice(0, 5);

        const hasAvailability = /налични|свободни|available|в наличност/i.test(text);
        const noAvailability = /няма налични|sold out|unavailable|заети/i.test(text);

        return {
          url: window.location.href,
          title: document.title,
          prices,
          hasAvailability,
          noAvailability,
          textSnippet: text.slice(0, 300).replace(/\s+/g, " "),
        };
      });
    } catch {
      return { url: "", title: "", prices: [] };
    }
  }

  private async observeDOM(page: Page) {
    try {
      return await page.evaluate(() => {
        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
        };

        const getSelector = (el: Element, idx: number): string => {
          if ((el as any).id) return `#${(el as any).id}`;
          if ((el as any).className && typeof (el as any).className === "string") {
            const cls = (el as any).className.trim().split(/\s+/)[0];
            if (cls && !cls.includes(":")) return `.${cls}`;
          }
          return `${el.tagName.toLowerCase()}:nth-of-type(${idx + 1})`;
        };

        const buttons = Array.from(
          document.querySelectorAll("button, a[href], [role='button'], input[type='submit'], .btn")
        )
          .filter(isVisible)
          .slice(0, 25)
          .map((el, i) => ({
            text: ((el as any).textContent?.trim() || (el as any).value || "").slice(0, 80),
            selector: getSelector(el, i),
          }))
          .filter((b) => b.text.length > 0);

        const priceRegex = /(\d+[\s,.]?\d*)\s*(лв\.?|BGN|EUR|€|\$)/gi;
        const bodyText = document.body.innerText;
        const prices = [...bodyText.matchAll(priceRegex)].map((m) => m[0]).slice(0, 10);

        return { buttons, prices };
      });
    } catch {
      return { buttons: [], prices: [] };
    }
  }

  private detectButtonType(text: string): SiteMapButton["action_type"] {
    const lower = text.toLowerCase();
    if (/резерв|book|запази|reserve/i.test(lower)) return "booking";
    if (/контакт|contact|свържи/i.test(lower)) return "contact";
    if (/търси|search|провери|check|submit|изпрати/i.test(lower)) return "submit";
    return "other";
  }

  async closeSession(siteId: string): Promise<void> {
    const session = this.sessions.get(siteId);
    if (session) {
      try {
        await session.page.close();
        await session.context.close();
      } catch {}
      this.sessions.delete(siteId);
      console.log(`[SESSION] Closed: ${siteId}`);
    }
  }

  private cleanupSessions(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [siteId, session] of this.sessions) {
      if (now - session.lastActivity > this.SESSION_TIMEOUT) {
        this.closeSession(siteId);
        cleaned++;
      }
    }

    if (cleaned > 0) console.log(`[CLEANUP] Closed ${cleaned} inactive sessions`);
  }

  private evictOldestSession(): void {
    let oldest: { id: string; time: number } | null = null;

    for (const [id, session] of this.sessions) {
      if (!oldest || session.lastActivity < oldest.time) oldest = { id, time: session.lastActivity };
    }

    if (oldest) {
      console.log(`[EVICT] Closing oldest session: ${oldest.id}`);
      this.closeSession(oldest.id);
    }
  }

  getStatus() {
    return {
      ready: this.isReady,
      sessions: this.sessions.size,
      maxSessions: this.MAX_SESSIONS,
      activeSites: Array.from(this.sessions.keys()),
      uptime: Math.floor(process.uptime()),
    };
  }

  async shutdown(): Promise<void> {
    console.log("[SHUTDOWN] Closing all sessions...");
    for (const [id] of this.sessions) {
      await this.closeSession(id);
    }
    if (this.browser) await this.browser.close();
    console.log("[SHUTDOWN] Done");
  }
}

async function main() {
  const manager = new HotSessionManager();

  const app = express();
  app.use(express.json({ limit: "10mb" }));

  // ✅ REQUEST LOGGER (ще видиш ВСЯКА заявка, even ако е 401)
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      console.log(`[REQ] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
    });
    next();
  });

  // Auth middleware
  app.use((req, res, next) => {
    if (req.path === "/" || req.path === "/health" || req.path === "/ping") return next();

    const token = req.headers.authorization?.replace("Bearer ", "");
    if (token !== WORKER_SECRET) {
      console.log(`[AUTH] Rejected request to ${req.path}`);
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }
    next();
  });

  app.get("/", (_, res) => {
    res.json({ name: "NEO Worker", version: "4.0.0", type: "hot-session", status: "running" });
  });

  // ✅ ultra-simple health endpoints (no auth)
  app.get("/ping", (_, res) => res.status(200).send("ok"));

  app.get("/health", (_, res) => {
    res.json({ status: "ok", ...manager.getStatus() });
  });

    // ✅ RELAY ENDPOINT: Supabase Edge -> Worker -> Crawler
  app.post("/relay/crawl", async (req: Request, res: Response) => {
    const { url, sessionId } = req.body || {};
    const requestId = sessionId ? String(sessionId) : `req-${Date.now()}`;
    const sanitizedHeaders = {
      "content-type": req.headers["content-type"],
      "user-agent": req.headers["user-agent"],
      "x-forwarded-for": req.headers["x-forwarded-for"],
      "x-request-id": req.headers["x-request-id"],
    };

    console.log("[RELAY] Incoming request", {
      requestId,
      method: req.method,
      path: req.path,
      ip: req.ip,
      headers: sanitizedHeaders,
      body: req.body || null,
      hasCrawlerSecret: Boolean(CRAWLER_SECRET),
      crawlerBaseUrl: CRAWLER_BASE_URL,
    });

    if (!CRAWLER_SECRET) {
      console.log("[RELAY] Missing CRAWLER_SECRET env");
      return res.status(500).json({ success: false, error: "CRAWLER_SECRET missing on worker" });
    }

    if (!url || !sessionId) {
      return res.status(400).json({ success: false, error: "Missing url or sessionId" });
    }

    const crawlUrl = `${CRAWLER_BASE_URL}/crawl`;
    console.log("[RELAY] ->", crawlUrl, {
      requestId,
      sessionId,
      url,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CRAWLER_SECRET ? "******" : ""}`,
        "x-crawler-token": CRAWLER_SECRET ? "******" : "",
        "x-request-id": requestId,
      },
      payload: { url, site_id: sessionId },
    });

    try {
      const start = Date.now();
      const r = await fetch(crawlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CRAWLER_SECRET}`,
          "x-crawler-token": CRAWLER_SECRET,
          "x-request-id": requestId,
        },
        body: JSON.stringify({ url, site_id: sessionId }),
      });
      const durationMs = Date.now() - start;

      const txt = await r.text().catch(() => "");
      console.log("[RELAY] <-", {
        requestId,
        status: r.status,
        durationMs,
        responseHeaders: {
          "content-type": r.headers.get("content-type"),
          "x-request-id": r.headers.get("x-request-id"),
        },
        responseBodyPreview: txt.slice(0, 500),
      });

      res.status(r.status);
      res.setHeader("Content-Type", "application/json");
      return res.send(txt);
    } catch (e) {
      console.log("[RELAY] fetch failed:", { requestId, error: e instanceof Error ? e.message : String(e) });
      return res.status(502).json({ success: false, error: "Relay failed to reach crawler" });
    }
  });


  // --- ROUTES (не пипаме логиката) ---
  app.post("/prepare-session", async (req, res) => {
    const { site_id, site_map } = req.body;
    if (!site_id || !site_map) return res.json({ success: false, error: "Missing site_id or site_map" });

    const success = await manager.prepareSession(site_id, site_map);
    res.json({ success, session_ready: success });
  });

  app.post("/execute", async (req, res) => {
    const { site_id, keywords, data } = req.body;
    if (!site_id || !Array.isArray(keywords)) return res.json({ success: false, message: "Invalid request" });

    const result = await manager.execute({ site_id, keywords, data });
    res.json(result);
  });

  app.post("/close-session", async (req, res) => {
    if (req.body.site_id) await manager.closeSession(req.body.site_id);
    res.json({ success: true });
  });

  app.post("/interact", async (req, res) => {
    const request = req.body as InteractRequest;
    if (!request.site_url || !request.user_message || !request.session_id) {
      return res.json({ success: false, message: "Missing fields", logs: [] });
    }
    const result = await manager.interact(request);
    res.json(result);
  });

  app.post("/close", async (req, res) => {
    if (req.body.session_id) await manager.closeSession(req.body.session_id);
    res.json({ success: true });
  });

  // ✅ IMPORTANT: bind to 0.0.0.0 for Render
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 NEO Worker v4.0 (Hot Sessions)`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Ready: ${manager.getStatus().ready}\n`);
  });

  manager
    .start()
    .then(() => console.log("[BOOT] HotSessionManager ready"))
    .catch((err) => console.error("[BOOT] HotSessionManager failed:", err));

  process.on("SIGTERM", async () => {
    console.log("\n[SIGTERM] Shutting down...");
    await manager.shutdown();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    console.log("\n[SIGINT] Shutting down...");
    await manager.shutdown();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
