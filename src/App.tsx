import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Link, Navigate, Outlet, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { Camera, Images, LayoutDashboard, LogOut, PackageSearch } from "lucide-react";
import { LoadingState } from "@/components/shared/LoadingState";
import { Button } from "@/components/ui/button";
import { AuthProvider, useAuth } from "@/auth/AuthProvider";
import { ProtectedAdminRoute } from "@/components/auth/ProtectedAdminRoute";
import { ProtectedUserRoute } from "@/components/auth/ProtectedUserRoute";

const Login = lazy(() => import("./pages/Login"));
const Signup = lazy(() => import("./pages/Signup"));
const ForgotPassword = lazy(() => import("./pages/ForgotPassword"));
const ResetPassword = lazy(() => import("./pages/ResetPassword"));
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

/** Shared customer chrome; administrative links only render for admins. */
function AppHeader() {
  const { status, user, signOut } = useAuth();
  return (
    <header className="border-b bg-background">
      <div className="container flex min-h-14 flex-wrap items-center justify-between gap-2 py-2">
        <Link to={status === "admin" ? "/dashboard" : "/scan-card"} className="font-semibold">
          GradedCardValue.com
        </Link>
        {/* A customer's world is: scan a slab, keep their own inventory, sign out.
            Administrative surfaces (dashboard, card inventory) stay admin-only. */}
        <nav className="order-3 flex w-full items-center justify-center gap-1 border-t pt-2 sm:order-none sm:w-auto sm:border-0 sm:pt-0" aria-label="Main navigation">
          <Button variant="ghost" size="sm" asChild><Link to="/scan-card"><Camera /> Scan Card</Link></Button>
          <Button variant="ghost" size="sm" asChild><Link to="/cards"><Images /> Raw Cards</Link></Button>
          <Button variant="ghost" size="sm" asChild><Link to="/slabs"><PackageSearch /> Slabs</Link></Button>
          {status === "admin" && <Button variant="ghost" size="sm" asChild><Link to="/dashboard"><LayoutDashboard /> Dashboard</Link></Button>}
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
      <AppHeader />
      <Outlet />
    </ProtectedAdminRoute>
  );
}

/**
 * Keep an in-progress slab audit mounted while the operator temporarily visits
 * another page. NewSlab owns File objects, AI proposals, the confirmed
 * PriceCharting product, valuation state, and review decisions; unmounting it
 * discards all of that browser-only state. Once /slabs/new has been visited, we
 * hide that same component instance instead of destroying it, then reveal it
 * when the operator returns.
 *
 * A successful save navigates directly from /slabs/new to /slabs/:id. That is
 * the one transition that intentionally discards the completed form so the next
 * Add a Slab visit starts clean.
 */
function ProtectedUserLayout() {
  const location = useLocation();
  const isNewSlab = location.pathname === "/slabs/new";
  const previousPath = useRef(location.pathname);
  const [keepNewSlabMounted, setKeepNewSlabMounted] = useState(isNewSlab);

  useEffect(() => {
    const cameFromNewSlab = previousPath.current === "/slabs/new";
    const openedSavedSlab = /^\/slabs\/[^/]+$/.test(location.pathname);

    if (isNewSlab) {
      setKeepNewSlabMounted(true);
    } else if (cameFromNewSlab && openedSavedSlab) {
      // NewSlab navigates here only after creating the record (including the
      // retry/recovery path). Unmount the completed form so stale card data does
      // not appear when the operator begins the next audit.
      setKeepNewSlabMounted(false);
    }

    previousPath.current = location.pathname;
  }, [isNewSlab, location.pathname]);

  return (
    <ProtectedUserRoute>
      <AppHeader />
      {keepNewSlabMounted && (
        <div hidden={!isNewSlab} aria-hidden={!isNewSlab}>
          <NewSlab />
        </div>
      )}
      {!isNewSlab && <Outlet />}
    </ProtectedUserRoute>
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
              <Route path="/signup" element={<Signup />} />
              <Route path="/forgot-password" element={<ForgotPassword />} />
              <Route path="/reset-password" element={<ResetPassword />} />
              <Route path="/" element={<Navigate to="/scan-card" replace />} />
              {/* Verified customers own a private slab inventory: they scan, complete
                  intake, and manage their own slabs. Row-level security — not this
                  route table — is what confines them to their own rows. */}
              {/* Verified customers own two private inventories: raw cards (R codes,
                  /cards) and graded slabs (S codes, /slabs). Row-level security —
                  not this route table — confines each customer to their own rows. */}
              <Route element={<ProtectedUserLayout />}>
                <Route path="/scan-card" element={<ScanCard />} />
                <Route path="/cards" element={<CardList />} />
                <Route path="/cards/:id" element={<CardDetail />} />
                <Route path="/slabs" element={<SlabList />} />
                {/* ProtectedUserLayout owns the persistent NewSlab instance. */}
                <Route path="/slabs/new" element={<></>} />
                <Route path="/slabs/:id" element={<SlabDetail />} />
              </Route>
              {/* Administrative tools stay admin-only: dashboard, marketplace, eBay,
                  exports, bulk actions, and system settings. */}
              <Route element={<ProtectedAdminLayout />}>
                <Route path="/dashboard" element={<SlabDashboard />} />
              </Route>
              <Route path="*" element={<Navigate to="/scan-card" replace />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
