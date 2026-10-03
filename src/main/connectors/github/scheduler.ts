import { ToolQueue } from "../../tool-queue";

/** Serial service operations with cancellable, observable waiting. */
export class RequestQueue extends ToolQueue {
  constructor() {
    super(1);
  }
}
