import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { LoadingState } from "@/components/shared/LoadingState";

const SlabDashboard = lazy(() => import("./pages/slabs/SlabDashboard"));
const SlabList = lazy(() => import("./pages/slabs/SlabList"));
const NewSlab = lazy(() => import("./pages/slabs/NewSlab"));
const SlabDetail = lazy(() => import("./pages/slabs/SlabDetail"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 60_000 } },
});

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Toaster richColors position="top-right" />
        <Suspense fallback={<div className="container py-12"><LoadingState message="Loading…" /></div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<SlabDashboard />} />
            <Route path="/slabs" element={<SlabList />} />
            <Route path="/slabs/new" element={<NewSlab />} />
            <Route path="/slabs/:id" element={<SlabDetail />} />
            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
