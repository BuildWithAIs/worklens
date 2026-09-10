import React from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "./components/ui/toast";
import { App } from "./App";
import "./style.css";
import { LocaleProvider } from "./lib/locale";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LocaleProvider>
      <Toaster>
        <App />
      </Toaster>
    </LocaleProvider>
  </React.StrictMode>,
);
