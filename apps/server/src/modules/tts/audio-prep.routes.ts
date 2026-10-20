import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { audioPrepService, AudioPrepError } from './audio-prep.service';

const voiceSchema = z.object({
  voiceId: z.string().min(1),
  speed: z.number().min(0.5).max(2.0),
  temperature: z.number().min(0).max(1),
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  time: z.string().optional(),
  timezone: z.string().optional(),
  voiceId: z.string().min(1).optional(),
  speed: z.number().min(0.5).max(2.0).optional(),
  temperature: z.number().min(0).max(1).optional(),
});

const selectionSchema = z.object({
  bookIds: z.array(z.string()).max(5000),
  selected: z.boolean(),
  voice: voiceSchema.optional(),
});

export const audioPrepRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('onRequest', async (request, reply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  const fail = (reply: any, error: unknown, fallback: string) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ error: 'Invalid input', details: error.errors });
    }
    if (error instanceof AudioPrepError) {
      return reply.code(error.statusCode).send({ error: error.message });
    }
    const message = error instanceof Error ? error.message : fallback;
    return reply.code(message.startsWith('Time ') || message.startsWith('Unknown time') ? 400 : 500).send({ error: message });
  };

  // Settings, every book's audio status, and what is running
  app.get('/', async (request, reply) => {
    try {
      const userId = (request.user as any).userId;
      return reply.send(await audioPrepService.listForUser(userId));
    } catch (error) {
      return fail(reply, error, 'Failed to load audio status');
    }
  });

  app.put('/settings', async (request, reply) => {
    try {
      const body = settingsSchema.parse(request.body);
      return reply.send(await audioPrepService.updateSettings(body));
    } catch (error) {
      return fail(reply, error, 'Failed to save settings');
    }
  });

  // Tick or untick books for the scheduled run
  app.put('/selection', async (request, reply) => {
    try {
      const userId = (request.user as any).userId;
      const body = selectionSchema.parse(request.body);
      const changed = await audioPrepService.setSelected(userId, body.bookIds, body.selected, body.voice);
      return reply.send({ changed });
    } catch (error) {
      return fail(reply, error, 'Failed to save selection');
    }
  });

  // Run the ticked books now
  app.post('/run', async (request, reply) => {
    try {
      const count = await audioPrepService.runSelectedNow();
      return reply.code(202).send({ queued: count });
    } catch (error) {
      return fail(reply, error, 'Failed to start');
    }
  });

  app.post<{ Params: { bookId: string } }>('/books/:bookId/prepare', async (request, reply) => {
    try {
      const userId = (request.user as any).userId;
      const voice = voiceSchema.parse(request.body);
      await audioPrepService.prepareBook(userId, request.params.bookId, voice);
      return reply.code(202).send({ queued: true });
    } catch (error) {
      return fail(reply, error, 'Failed to start');
    }
  });

  app.post<{ Params: { bookId: string } }>('/books/:bookId/cancel', async (request, reply) => {
    try {
      const userId = (request.user as any).userId;
      await audioPrepService.cancelBook(userId, request.params.bookId);
      return reply.send({ success: true });
    } catch (error) {
      return fail(reply, error, 'Failed to cancel');
    }
  });

  app.delete<{ Params: { bookId: string } }>('/books/:bookId/audio', async (request, reply) => {
    try {
      const userId = (request.user as any).userId;
      const removed = await audioPrepService.deleteAudio(userId, request.params.bookId);
      return reply.send({ success: true, removed });
    } catch (error) {
      return fail(reply, error, 'Failed to delete audio');
    }
  });
};
