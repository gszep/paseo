import AsyncStorage from "@react-native-async-storage/async-storage";
import { createMentionSubmissions } from "./mention-submission";

export const mentionSubmissions = createMentionSubmissions(AsyncStorage);
