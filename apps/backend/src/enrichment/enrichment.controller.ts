import { Controller } from '@nestjs/common';
import { ApiRoute } from '../core/route.js';
import { paged } from '../core/envelope.js';
import { NameCheckCatalog } from '../core/ports.js';

@Controller()
export class EnrichmentController {
  constructor(private readonly catalog: NameCheckCatalog) {}


  @ApiRoute('listNameCheckServices')
  listNameCheckServices() {
    const services = this.catalog.services();
    return paged(services, null, services.length);
  }
}
