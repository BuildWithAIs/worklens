import { createContext, useContext } from "react";
import type { Bootstrap, Selection } from "../../../../shared/contracts";

export type ModelMenuProps = {
  data: Bootstrap;
  selection?: Selection;
  onChange: (value: Selection) => void;
  onManage: () => void;
};

export const ModelMenuContext = createContext<ModelMenuProps | undefined>(
  undefined,
);
export const useModelMenuContext = () => useContext(ModelMenuContext);
