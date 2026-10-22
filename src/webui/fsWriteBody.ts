/**
 * Request bodies for the Files editor's save. The global JSON parser keeps its
 * 100 kB default, which would refuse a save the 1 MB file cap allows with only
 * "request entity too large", so the save route gets a parser of its own and
 * the global one skips it.
 */

import express, { NextFunction, Request, RequestHandler, Response } from 'express';

const FS_WRITE_ROUTE = /^\/api\/bots\/[^/]+\/fs\/write\/?$/;

// Above the 1 MB file cap with room for JSON escaping (a newline or a quote
// takes two bytes), so the cap itself is judged on the decoded file.
const FS_WRITE_JSON_LIMIT = '2mb';

const isFsWrite = (req: Request): boolean => req.method === 'PUT' && FS_WRITE_ROUTE.test(req.path);

/** The default JSON parser for every route except the save. */
export function jsonBodies(): RequestHandler {
  const parse = express.json();
  return (req: Request, res: Response, next: NextFunction) => (isFsWrite(req) ? next() : parse(req, res, next));
}

const parseFsWrite = express.json({ limit: FS_WRITE_JSON_LIMIT });

export function fsWriteBody(req: Request, res: Response, next: NextFunction): void {
  parseFsWrite(req, res, (err?: unknown) => {
    if (!err) { next(); return; }
    const tooLarge = (err as { type?: string }).type === 'entity.too.large';
    res.status(tooLarge ? 413 : 400).json({
      success: false,
      error: tooLarge ? 'Too large to save here (over 1 MB); the file was not changed' : 'The save request was not valid JSON; the file was not changed',
    });
  });
}
