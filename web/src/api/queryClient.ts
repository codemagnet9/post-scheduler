// src/api/queryClient.ts
// The single QueryClient, in its own module so the AuthProvider can clear the entire cache on sign-out
// (leaving one workspace's data in memory when the next person signs in on the same machine would be a
// privacy leak). retry:1 + no refetch-on-focus + a short staleTime match the app's read patterns.
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 } },
});
