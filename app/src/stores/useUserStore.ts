// Global user state via Zustand.
// Intentionally minimal — only hold what needs to be shared across screens.
// Profile data that only one screen needs should stay local to that screen.
import type { User } from "@/types";
import { create } from "zustand";

interface UserStore {
  user: User | null;
  setUser: (user: User) => void;
  clearUser: () => void;
}

export const useUserStore = create<UserStore>((set) => ({
  user: null,
  setUser: (user) => set({ user }),
  clearUser: () => set({ user: null }),
}));
