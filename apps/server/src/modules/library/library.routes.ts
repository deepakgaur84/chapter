import { FastifyPluginAsync } from 'fastify';
import { libraryService } from './library.service';

/**
 * The books folder is read-only and scanned by the server on its own (when it starts), so there
 * is nothing to configure here: just the progress of the scan, and bringing back removed books.
 */
export const libraryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch (error) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  // Progress of the background scan of the books folder
  app.get('/status', async (_request, reply) => {
    return reply.send(libraryService.getStatus());
  });

  // Books that were removed from the library and are skipped by the scan
  app.get('/hidden', async (_request, reply) => {
    try {
      return reply.send({ files: await libraryService.listHidden() });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list removed books';
      return reply.code(500).send({ error: message });
    }
  });

  // Bring removed books back (all of them, or the given files)
  app.post('/restore', async (request, reply) => {
    try {
      const body = (request.body || {}) as { ids?: string[] };
      const restored = await libraryService.restoreHidden(
        Array.isArray(body.ids) ? body.ids : undefined
      );
      return reply.send({ restored });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to restore books';
      return reply.code(500).send({ error: message });
    }
  });
};
