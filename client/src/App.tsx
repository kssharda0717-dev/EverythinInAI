import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import Launchpad from "./pages/Launchpad";
import Privacy from "./pages/Privacy";
import Terms from "./pages/Terms";

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/launchpad" component={Launchpad} />
      <Route path="/privacy" component={Privacy} />
      <Route path="/terms" component={Terms} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster
            position="bottom-center"
            toastOptions={{
              style: {
                background: "oklch(1 0 0 / 80%)",
                backdropFilter: "blur(20px)",
                border: "none",
                boxShadow: "0 4px 24px oklch(0.70 0.03 230 / 12%)",
              },
            }}
          />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
