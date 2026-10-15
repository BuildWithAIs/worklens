import { createContext } from "react";

// Next steps for the failed run at the end of the conversation. An action is
// absent when it cannot run now, so the error card leaves its button out.
export type RunErrorActions = {
  retry?: () => void;
  chooseModel?: () => void;
  openSettings?: () => void;
  newChat?: () => void;
  editMessage?: () => void;
};

export const RunErrorActionsContext = createContext<RunErrorActions>({});
