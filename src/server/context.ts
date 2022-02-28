import {
  extname,
  fromFileUrl,
  mediaTypeLookup,
  router,
  toFileUrl,
  walk,
} from "./deps.ts";
import { Routes } from "./mod.ts";
import { Bundler } from "./bundle.ts";
import { ALIVE_URL, INTERNAL_PREFIX, REFRESH_JS_URL } from "./constants.ts";
import { JS_PREFIX } from "./constants.ts";
import { BUILD_ID } from "./constants.ts";
import {
  AppModule,
  ErrorPage,
  ErrorPageModule,
  Handler,
  Middleware,
  MiddlewareModule,
  Page,
  PageModule,
  Renderer,
  RendererModule,
  UnknownPage,
  UnknownPageModule,
} from "./types.ts";
import { render as internalRender } from "./render.tsx";
import {
  ContentSecurityPolicy,
  ContentSecurityPolicyDirectives,
  SELF,
} from "../runtime/csp.ts";
import { h } from "../runtime/deps.ts";

interface StaticFile {
  /** The URL to the static file on disk. */
  localUrl: URL;
  /** The path to the file as it would be in the incoming request. */
  path: string;
  /** The size of the file. */
  size: number;
  /** The content-type of the file. */
  contentType: string;
  /** Hash of the file contents. */
  etag: string;
}

export class ServerContext {
  #dev: boolean;
  #pages: Page[];
  #staticFiles: StaticFile[];
  #bundler: Bundler;
  #renderer: Renderer;
  #middleware: Middleware;
  #app: AppModule;
  #notFound: UnknownPage;
  #error: ErrorPage;

  constructor(
    pages: Page[],
    staticFiles: StaticFile[],
    renderer: Renderer,
    middleware: Middleware,
    app: AppModule,
    notFound: UnknownPage,
    error: ErrorPage,
  ) {
    this.#pages = pages;
    this.#staticFiles = staticFiles;
    this.#renderer = renderer;
    this.#middleware = middleware;
    this.#app = app;
    this.#notFound = notFound;
    this.#error = error;
    this.#bundler = new Bundler(pages);
    this.#dev = typeof Deno.env.get("DENO_DEPLOYMENT_ID") !== "string"; // Env var is only set in prod (on Deploy).
  }

  /**
   * Process the routes into individual components and pages.
   */
  static async fromRoutes(routes: Routes): Promise<ServerContext> {
    // Get the routes' base URL.
    const baseUrl = new URL("./", routes.baseUrl).href;

    // Extract all routes, and prepare them into the `Page` structure.
    const pages: Page[] = [];
    let renderer: Renderer = DEFAULT_RENDERER;
    let middleware: Middleware = DEFAULT_MIDDLEWARE;
    let app: AppModule = DEFAULT_APP;
    let notFound: UnknownPage = DEFAULT_NOT_FOUND;
    let error: ErrorPage = DEFAULT_ERROR;
    for (const [self, module] of Object.entries(routes.pages)) {
      const url = new URL(self, baseUrl).href;
      if (!url.startsWith(baseUrl)) {
        throw new TypeError("Page is not a child of the basepath.");
      }
      const path = url.substring(baseUrl.length).substring("pages".length);
      const baseRoute = path.substring(1, path.length - extname(path).length);
      const name = baseRoute.replace("/", "-");
      if (!path.startsWith("/_")) {
        const { default: component, config } = (module as PageModule);
        let route = pathToRoute(baseRoute);
        if (config?.routeOverride) {
          route = String(config.routeOverride);
        }
        let { handler } = (module as PageModule);
        handler ??= {};
        if (
          component &&
          typeof handler === "object" && handler.GET === undefined
        ) {
          handler.GET = ({ render }) => render!();
        }
        const page: Page = {
          route,
          url,
          name,
          component,
          handler,
          runtimeJS: Boolean(config?.runtimeJS ?? false),
          csp: Boolean(config?.csp ?? false),
        };
        pages.push(page);
      } else if (
        path === "/_render.tsx" || path === "/_render.ts" ||
        path === "/_render.jsx" || path === "/_render.js"
      ) {
        renderer = module as RendererModule;
      } else if (
        path === "/_middleware.tsx" || path === "/_middleware.ts" ||
        path === "/_middleware.jsx" || path === "/_middleware.js"
      ) {
        middleware = module as MiddlewareModule;
      } else if (
        path === "/_app.tsx" || path === "/_app.ts" ||
        path === "/_app.jsx" || path === "/_app.js"
      ) {
        app = module as AppModule;
      } else if (
        path === "/_404.tsx" || path === "/_404.ts" ||
        path === "/_404.jsx" || path === "/_404.js"
      ) {
        const { default: component, config } = (module as UnknownPageModule);
        let { handler } = (module as UnknownPageModule);
        if (component && handler === undefined) {
          handler = ({ render }) => render!();
        }

        notFound = {
          route: pathToRoute(baseRoute),
          url,
          name,
          component,
          handler: handler ?? ((ctx) => router.defaultOtherHandler(ctx.req)),
          runtimeJS: Boolean(config?.runtimeJS ?? false),
          csp: Boolean(config?.csp ?? false),
        };
      } else if (
        path === "/_500.tsx" || path === "/_500.ts" ||
        path === "/_500.jsx" || path === "/_500.js"
      ) {
        const { default: component, config } = (module as ErrorPageModule);
        let { handler } = (module as ErrorPageModule);
        if (component && handler === undefined) {
          handler = ({ render }) => render!();
        }

        error = {
          route: pathToRoute(baseRoute),
          url,
          name,
          component,
          handler: handler ??
            ((ctx) => router.defaultErrorHandler(ctx.req, ctx.error)),
          runtimeJS: Boolean(config?.runtimeJS ?? false),
          csp: Boolean(config?.csp ?? false),
        };
      }
    }
    sortRoutes(pages);

    const staticFiles: StaticFile[] = [];
    try {
      const staticFolder = new URL("./static", routes.baseUrl);
      // TODO(lucacasonato): remove the extranious Deno.readDir when
      // https://github.com/denoland/deno_std/issues/1310 is fixed.
      for await (const _ of Deno.readDir(fromFileUrl(staticFolder))) {
        // do nothing
      }
      const entires = walk(fromFileUrl(staticFolder), {
        includeFiles: true,
        includeDirs: false,
        followSymlinks: false,
      });
      for await (const entry of entires) {
        const localUrl = toFileUrl(entry.path);
        const path = localUrl.href.substring(staticFolder.href.length);
        const stat = await Deno.stat(localUrl);
        const body = await (await fetch(localUrl)).arrayBuffer();
        const etag = await crypto.subtle.digest("SHA-1", body).then((hash) =>
          Array.from(new Uint8Array(hash))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("")
        );
        const contentType = mediaTypeLookup(extname(path)) ??
          "application/octet-stream";
        const staticFile: StaticFile = {
          localUrl,
          path,
          size: stat.size,
          contentType,
          etag,
        };
        staticFiles.push(staticFile);
      }
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        // Do nothing.
      } else {
        throw err;
      }
    }
    return new ServerContext(
      pages,
      staticFiles,
      renderer,
      middleware,
      app,
      notFound,
      error,
    );
  }

  /**
   * This functions returns a request handler that handles all routes required
   * by fresh, including static files.
   */
  handler(): router.RequestHandler {
    const inner = router.router(...this.#routes());
    const middleware = this.#middleware;
    return function handler(req: Request) {
      // Redirect requests that end with a trailing slash
      // to their non-trailing slash counterpart.
      // Ex: /about/ -> /about
      const url = new URL(req.url);
      if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
        url.pathname = url.pathname.slice(0, -1);
        return Response.redirect(url.href, 307);
      }
      const handle = () => Promise.resolve(inner(req));
      return middleware.handler(req, handle);
    };
  }

  /**
   * This function returns all routes required by fresh as an extended
   * path-to-regex, to handler mapping.
   */
  #routes(): [router.Routes, router.RequestHandler, router.ErrorHandler] {
    const routes: router.Routes = {};

    // Add the static file routes.
    for (
      const { localUrl, path, size, contentType, etag } of this.#staticFiles
    ) {
      const route = sanitizePathToRegex(path);
      routes[`GET@${route}`] = this.#staticFileHandler(
        localUrl,
        size,
        contentType,
        etag,
      );
    }

    const genRender = (page: Page, status: number) => {
      const bundlePath = `/${page.name}.js`;
      const imports = page.runtimeJS ? [bundleAssetUrl(bundlePath)] : [];
      if (this.#dev) {
        imports.push(REFRESH_JS_URL);
      }
      return (
        req: Request,
        params: Record<string, string | string[]>,
        error?: unknown,
      ) => {
        if (page.component === undefined) return undefined;
        return async (renderData?: Record<string, unknown>) => {
          const preloads = page.runtimeJS
            ? this.#bundler.getPreloads(bundlePath).map(bundleAssetUrl)
            : [];
          const body = internalRender({
            page,
            app: this.#app,
            imports,
            preloads,
            renderer: this.#renderer,
            url: new URL(req.url),
            params,
            renderData,
            error,
          });

          const headers: Record<string, string> = {
            "content-type": "text/html; charset=utf-8",
          };
          let firstChunk: string;
          const iterator = body[Symbol.asyncIterator]();
          try {
            const { value, done } = await iterator.next();
            if (done) throw new Error("Body is empty.");
            firstChunk = value[0];
            const csp: ContentSecurityPolicy | undefined = value[1];
            if (csp) {
              if (this.#dev) {
                csp.directives.connectSrc = [
                  ...(csp.directives.connectSrc ?? []),
                  SELF,
                ];
              }
              const directive = serializeCSPDirectives(csp.directives);
              if (csp.reportOnly) {
                headers["content-security-policy-report-only"] = directive;
              } else {
                headers["content-security-policy"] = directive;
              }
            }
          } catch (err) {
            console.error("Error rendering page", err);
            throw new Response("500 Internal Server Error", {
              status: 500,
              headers: {
                "content-type": "text/plain",
              },
            });
          }
          const bodyStream = new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(firstChunk));
              try {
                for await (const chunk of body) {
                  controller.enqueue(new TextEncoder().encode(chunk as string));
                }
              } catch (err) {
                console.log("Rendering failed:\n", err);
                controller.enqueue(
                  new TextEncoder().encode("500 Internal Server Error"),
                );
              }
              controller.close();
            },
          });
          return new Response(bodyStream, { status, headers });
        };
      };
    };

    for (const page of this.#pages) {
      const createRender = genRender(page, 200);
      if (typeof page.handler === "function") {
        routes[page.route] = (req, match) =>
          (page.handler as Handler)({
            req,
            match,
            render: createRender(req, match),
          });
      } else {
        for (const [method, handler] of Object.entries(page.handler)) {
          routes[`${method}@${page.route}`] = (req, match) =>
            handler({ req, match, render: createRender(req, match) });
        }
      }
    }

    const unknownHandlerRender = genRender(this.#notFound, 404);
    const unknownHandler = (req: Request) =>
      (this.#notFound.handler as Handler)({
        req,
        match: {},
        render: unknownHandlerRender(req, {}),
      });

    const errorHandlerRender = genRender(this.#error, 500);
    const errorHandler = (req: Request, error: unknown) =>
      (this.#notFound.handler as Handler)({
        req,
        match: {},
        render: errorHandlerRender(req, {}, error),
      });

    routes[`${INTERNAL_PREFIX}${JS_PREFIX}/${BUILD_ID}/:path*`] = this
      .#bundleAssetRoute();

    if (this.#dev) {
      routes[REFRESH_JS_URL] = () => {
        const js =
          `const buildId = "${BUILD_ID}"; new EventSource("${ALIVE_URL}").addEventListener("message", (e) => { if (e.data !== buildId) { location.reload(); } });`;
        return new Response(new TextEncoder().encode(js), {
          headers: {
            "content-type": "application/javascript; charset=utf-8",
          },
        });
      };
      routes[ALIVE_URL] = () => {
        let timerId: number | undefined = undefined;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(`data: ${BUILD_ID}\nretry: 100\n\n`);
            timerId = setInterval(() => {
              controller.enqueue(`data: ${BUILD_ID}\n\n`);
            }, 1000);
          },
          cancel() {
            if (timerId !== undefined) {
              clearInterval(timerId);
            }
          },
        });
        return new Response(body.pipeThrough(new TextEncoderStream()), {
          headers: {
            "content-type": "text/event-stream",
          },
        });
      };
    }

    return [routes, unknownHandler, errorHandler];
  }

  #staticFileHandler(
    localUrl: URL,
    size: number,
    contentType: string,
    etag: string,
  ): router.MatchHandler {
    return async (req: Request) => {
      if (req.headers.get("if-none-match") === etag) {
        return new Response(null, { status: 304 });
      } else {
        const resp = await fetch(localUrl);
        return new Response(resp.body, {
          headers: {
            "content-type": contentType,
            "content-length": String(size),
            "etag": etag,
          },
        });
      }
    };
  }

  /**
   * Returns a router that contains all fresh routes. Should be mounted at
   * constants.INTERNAL_PREFIX
   */
  #bundleAssetRoute = (): router.MatchHandler => {
    return async (_req, match) => {
      const path = `/${match.path}`;
      const file = await this.#bundler.get(path);
      let res;
      if (file) {
        const headers = new Headers({
          "Cache-Control": "public, max-age=604800, immutable",
        });

        const contentType = mediaTypeLookup(path);
        if (contentType) {
          headers.set("Content-Type", contentType);
        }

        res = new Response(file, {
          status: 200,
          headers,
        });
      }

      return res ?? new Response(null, {
        status: 404,
      });
    };
  };
}

function bundleAssetUrl(path: string) {
  return `${INTERNAL_PREFIX}${JS_PREFIX}/${BUILD_ID}${path}`;
}

const DEFAULT_RENDERER: Renderer = {
  render(_ctx, render) {
    render();
  },
};

const DEFAULT_MIDDLEWARE: Middleware = {
  handler: (_, handle) => handle(),
};

const DEFAULT_APP: AppModule = {
  default: ({ Component }) => h(Component, {}),
};

const DEFAULT_NOT_FOUND: UnknownPage = {
  route: "",
  url: "",
  name: "_404",
  handler: (ctx) => router.defaultOtherHandler(ctx.req),
  runtimeJS: false,
  csp: false,
};

const DEFAULT_ERROR: ErrorPage = {
  route: "",
  url: "",
  name: "_500",
  handler: (ctx) => router.defaultErrorHandler(ctx.req, ctx.error),
  runtimeJS: false,
  csp: false,
};

/**
 * Sort pages by their relative routing priority, based on the parts in the
 * route matcher
 */
function sortRoutes<T extends { route: string }>(routes: T[]) {
  routes.sort((a, b) => {
    const partsA = a.route.split("/");
    const partsB = b.route.split("/");
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      const partA = partsA[i];
      const partB = partsB[i];
      if (partA === undefined) return -1;
      if (partB === undefined) return 1;
      if (partA === partB) continue;
      const priorityA = partA.startsWith(":") ? partA.endsWith("*") ? 0 : 1 : 2;
      const priorityB = partB.startsWith(":") ? partB.endsWith("*") ? 0 : 1 : 2;
      return Math.max(Math.min(priorityB - priorityA, 1), -1);
    }
    return 0;
  });
}

/** Transform a filesystem URL path to a `path-to-regex` style matcher. */
function pathToRoute(path: string): string {
  const parts = path.split("/");
  if (parts[parts.length - 1] === "index") {
    parts.pop();
  }
  const route = "/" + parts
    .map((part) => {
      if (part.startsWith("[...") && part.endsWith("]")) {
        return `:${part.slice(4, part.length - 1)}*`;
      }
      if (part.startsWith("[") && part.endsWith("]")) {
        return `:${part.slice(1, part.length - 1)}`;
      }
      return part;
    })
    .join("/");
  return route;
}

// Normalize a path for use in a URL. Returns null if the path is unparsable.
export function normalizeURLPath(path: string): string | null {
  try {
    const pathUrl = new URL("file:///");
    pathUrl.pathname = path;
    return pathUrl.pathname;
  } catch {
    return null;
  }
}

function sanitizePathToRegex(path: string): string {
  return path
    .replaceAll("\*", "\\*")
    .replaceAll("\+", "\\+")
    .replaceAll("\?", "\\?")
    .replaceAll("\{", "\\{")
    .replaceAll("\}", "\\}")
    .replaceAll("\(", "\\(")
    .replaceAll("\)", "\\)")
    .replaceAll("\:", "\\:");
}

function serializeCSPDirectives(csp: ContentSecurityPolicyDirectives): string {
  return Object.entries(csp)
    .filter(([_key, value]) => value !== undefined)
    .map(([k, v]: [string, string | string[]]) => {
      // Turn camel case into snake case.
      const key = k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      const value = Array.isArray(v) ? v.join(" ") : v;
      return `${key} ${value}`;
    })
    .join("; ");
}
