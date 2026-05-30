import type { Request, Response, NextFunction, RequestHandler } from "express";

export function requirePermission(capability: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (req.user.role === "admin" || req.user.capabilities?.has(capability)) { next(); return; }
    res.status(403).json({ error: "forbidden" });
  };
}

export function requireBotAccess(paramName = "botId"): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: "unauthenticated" }); return; }
    if (req.user.role === "admin" || req.user.bots === "all") { next(); return; }
    const botId = req.params[paramName];
    if (typeof botId === "string" && req.user.bots instanceof Set && req.user.bots.has(botId)) { next(); return; }
    res.status(403).json({ error: "forbidden" });
  };
}
