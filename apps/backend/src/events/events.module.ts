import { Module } from '@nestjs/common';
import { EventsCompactor } from './events.compactor.js';
import { DEFAULT_SSE_OPTIONS, EventsController, SSE_OPTIONS } from './events.controller.js';


@Module({
  controllers: [EventsController],
  providers: [EventsCompactor, { provide: SSE_OPTIONS, useValue: DEFAULT_SSE_OPTIONS }],
})
export class EventsModule {}
