import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { Footer } from "@/components/Footer";
import { Nav } from "@/components/Nav";
import { SkipLink } from "@/components/SkipLink";
import { Audiences } from "@/sections/Audiences";
import { Cta } from "@/sections/Cta";
import { Faq } from "@/sections/Faq";
import { Hero } from "@/sections/Hero";
import { How } from "@/sections/How";
import { Privacy } from "@/sections/Privacy";
import { Trust } from "@/sections/Trust";

function Home() {
  return (
    <div className="min-h-dvh overflow-x-clip">
      <SkipLink />
      <Nav />
      <main id="main">
        <Hero />
        <How />
        <Audiences />
        <Trust />
        <Privacy />
        <Faq />
        <Cta />
      </main>
      <Footer />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
