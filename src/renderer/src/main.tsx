import React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "./components/ui/toast";
import { App } from "./App";
import "./style.css";
import "./i18n";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Toaster>
      <App />
    </Toaster>
  </React.StrictMode>,
);
