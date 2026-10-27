import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Landing } from "./Landing";
import { NotFound, Security } from "./Security";
import { useRoute } from "./router";
import "./styles.css";
import "./site.css";
import "./app.css";

function Root() {
  const route = useRoute();
  if (route === "/") return <Landing />;
  if (route === "/app") return <App />;
  if (route === "/security") return <Security />;
  return <NotFound />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
