import { lazy, Suspense } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes } from "react-router-dom";
import { Toaster } from "sonner";
import { Camera, Images, LayoutDashboard, LogOut, PackageSearch } from "lucide-react";
import { LoadingState } from "@/components/shared/LoadingState";
import { Button } from "@/components/ui/button";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { ProtectedAdminRoute } from "@/components/auth/ProtectedAdminRoute";

const Login = lazy(() => import("./pages/Login"));
const SlabDashboard = lazy(() => import("./pages/slabs/SlabDashboard"));
const SlabList = lazy(() => import("./pages/slabs/SlabList"));
const NewSlab = lazy(() => import("./pages/slabs/NewSlab"));
const SlabDetail = lazy(() => import("./pages/slabs/SlabDetail"));
const ScanCard = lazy(() => import("./pages/cards/ScanCard"));
const CardList = lazy(() => import("./pages/cards/CardList"));
const CardDetail = lazy(() => import("./pages/cards/CardDetail"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 60_000 } },
});

/** Chrome shown around every protected page: a header with a sign-out control. */
function AdminHeader() {
  const { user, signOut } = useAuth();
  return (
    <header className="border-b bg-background">
      <div className="container flex min-h-14 flex-wrap items-center justify-between gap-2 py-2">
        <Link to="/dashboard" className="font-semibold">
          GradedCardValue.com
        </Link>
        <nav className="order-3 flex w-full items-center justify-center gap-1 border-t pt-2 sm:order-none sm:w-auto sm:border-0 sm:pt-0" aria-label="Main navigation">
          <Button variant="ghost" size="sm" asChild><Link to="/scan-card"><Camera /> Scan Card</Link></Button>
          <Button variant="ghost" size="sm" asChild><Link to="/dashboard"><LayoutDashboard /> Dashboard</Link></Button>
          <Button variant="ghost" size="sm" asChild><Link to="/cards"><Images /> Cards</Link></Button>
          <Button variant="ghost" size="sm" asChild><Link to="/slabs"><PackageSearch /> Slabs</Link></Button>
        </nav>
        <div className="flex items-center gap-3 text-sm">
          {user?.email && <span className="text-muted-foreground">{user.email}</span>}
          <Button variant="outline" size="sm" onClick={() => void signOut()}>
            <LogOut className="mr-1 h-4 w-4" /> Sign out
          </Button>
        </div>
      </div>
    </header>
  );
}

/** Layout route: gate on admin, then render the header + the matched page. */
function ProtectedAdminLayout() {
  return (
    <ProtectedAdminRoute>
      <AdminHeader />
      <Outlet />
    </ProtectedAdminRoute>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Toaster richColors position="top-right" />
          <Suspense fallback={<div className="container py-12"><LoadingState message="Loading…" /></div>}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route element={<ProtectedAdminLayout />}>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<SlabDashboard />} />
                <Route path="/slabs" element={<SlabList />} />
                <Route path="/slabs/new" element={<NewSlab />} />
                <Route path="/slabs/:id" element={<SlabDetail />} />
                <Route path="/scan-card" element={<ScanCard />} />
                <Route path="/cards" element={<CardList />} />
                <Route path="/cards/:id" element={<CardDetail />} />
              </Route>
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
