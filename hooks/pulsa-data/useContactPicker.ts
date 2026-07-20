import * as Contacts from "expo-contacts";
import { useCallback, useState } from "react";
import { Alert } from "react-native";

export interface PhoneContactEntry {
  id: string;
  name: string;
  number: string;
  label?: string;
}

interface UseContactPickerOptions {
  onPhoneSelected: (phone: string, name?: string) => void;
}

export function useContactPicker({ onPhoneSelected }: UseContactPickerOptions) {
  const [visible, setVisible] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [contacts, setContacts] = useState<PhoneContactEntry[]>([]);

  const closePicker = useCallback(() => setVisible(false), []);

  const handleSelect = useCallback(
    (entry: PhoneContactEntry) => {
      // Pass the contact name only when it's a real name (the flattener
      // falls back to the number itself when a contact is unnamed).
      const name =
        entry.name && entry.name !== entry.number ? entry.name : undefined;
      onPhoneSelected(entry.number, name);
      setVisible(false);
    },
    [onPhoneSelected],
  );

  const pickContact = useCallback(async () => {
    try {
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Permission needed",
          "Allow contacts access to pick a phone number.",
        );
        return;
      }

      // Open the sheet immediately with a loading state so it feels responsive
      // while we read what can be a large contact book.
      setContacts([]);
      setIsLoading(true);
      setVisible(true);

      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers],
      });

      // Flatten to one entry per phone number (a contact can have several) and
      // de-duplicate by normalized digits so the list stays clean.
      const entries: PhoneContactEntry[] = [];
      const seen = new Set<string>();
      for (const contact of data) {
        if (!contact.phoneNumbers?.length) continue;
        for (const phone of contact.phoneNumbers) {
          const number = phone.number?.trim();
          if (!number) continue;
          const dedupeKey = number.replace(/\D/g, "");
          if (!dedupeKey || seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          entries.push({
            id: `${contact.id ?? dedupeKey}-${phone.id ?? dedupeKey}`,
            name: contact.name?.trim() || number,
            number,
            label: phone.label,
          });
        }
      }

      setContacts(entries);
    } catch (error) {
      if (__DEV__) console.warn("Failed to load contacts:", error);
      setVisible(false);
      Alert.alert(
        "Couldn't open contacts",
        "We couldn't load your contacts. Please try again.",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    pickContact,
    closePicker,
    handleSelect,
    visible,
    isLoading,
    contacts,
  };
}
