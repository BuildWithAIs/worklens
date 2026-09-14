import { z } from "zod";
import type { Requests } from "../../shared/contracts";
import { connectionSchema } from "./confluence/connection";
import type { ConfluenceService } from "./confluence/service";

// Keep explicit typed requests until a second connector establishes shared needs.
export const connectorSchemas = {
  confluenceSave: connectionSchema,
  confluenceTest: connectionSchema,
  confluenceRemove: z.undefined(),
};
type ConnectorRequest = keyof typeof connectorSchemas;
export function isConnectorRequest(
  method: keyof Requests,
): method is ConnectorRequest {
  return Object.hasOwn(connectorSchemas, method);
}
export function connectorRequests(confluence: ConfluenceService) {
  const handlers: {
    [K in ConnectorRequest]: (
      input: Requests[K]["input"],
    ) => Promise<Requests[K]["output"]>;
  } = {
    confluenceSave: (input) => confluence.connections.save(input),
    confluenceTest: (input) => confluence.test(input),
    confluenceRemove: () => confluence.connections.remove(),
  };
  return <K extends ConnectorRequest>(
    method: K,
    input: Requests[K]["input"],
  ): Promise<Requests[K]["output"]> => handlers[method](input);
}
