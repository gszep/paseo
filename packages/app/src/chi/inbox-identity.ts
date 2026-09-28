import AsyncStorage from "@react-native-async-storage/async-storage";
import { createInboxAuthority } from "./inbox-authority";

export const inboxAuthority = createInboxAuthority(AsyncStorage);
