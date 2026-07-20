import { useCallback, useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import type { TProduct } from "@/api/types/product";
import {
  detectProvider,
  PROVIDER_CONFIG,
  type ProviderKey,
} from "@/constants/ISP-list";
import {
  useProductById,
  useProductInputFields,
} from "@/hooks/queries/useProducts";
import useRQGlobalState from "@/hooks/useRQGlobalState";
import { normalizeNumberKey } from "@/services/ppob/recentNumbers";

const MAX_PHONE_LENGTH = 12;
const MIN_VALID_LENGTH = 11;
const MIN_PREFIX_LENGTH = 4;

const PHONE_NUMBER_QUERY_KEY = ["pulsa-data", "phone-number"] as const;
const CATEGORY_PRODUCTS_QUERY_KEY = [
  "pulsa-data",
  "category-products",
] as const;
const CONTACT_LABEL_QUERY_KEY = ["pulsa-data", "contact-label"] as const;

interface ContactLabel {
  /** Normalized number key the label belongs to. */
  key: string;
  name: string;
}

/**
 * Remembers the contact name for a number picked from the contact book,
 * so `recordNumberUsage` can attach it to the "Frequently used" chip.
 * Keyed by normalized number so a stale label never bleeds onto a
 * different, manually-typed number.
 */
export function useContactLabel() {
  const { data, setNewData } = useRQGlobalState<ContactLabel | null>({
    queryKey: CONTACT_LABEL_QUERY_KEY,
    initialData: null,
  });
  return { contactLabel: data ?? null, setContactLabel: setNewData };
}

interface PhoneNumberFormValues {
  phoneNumber: string;
}

export function usePhoneNumberForm() {
  const { data: globalPhoneNumber, setNewData: setGlobalPhoneNumber } =
    useRQGlobalState<string>({
      queryKey: PHONE_NUMBER_QUERY_KEY,
      initialData: "",
    });

  const { control, watch, setValue } = useForm<PhoneNumberFormValues>({
    defaultValues: {
      phoneNumber: globalPhoneNumber ?? "",
    },
    mode: "onChange",
  });

  const localPhoneNumber = watch("phoneNumber");
  const { setContactLabel } = useContactLabel();

  // Sync local form state to global state
  useEffect(() => {
    if (localPhoneNumber !== globalPhoneNumber) {
      setGlobalPhoneNumber(localPhoneNumber);
    }
  }, [localPhoneNumber, globalPhoneNumber, setGlobalPhoneNumber]);

  const setPhoneFromContact = useCallback(
    (phone: string, name?: string) => {
      let cleaned = phone.replace(/\D/g, "");
      if (cleaned.startsWith("62")) {
        cleaned = "0" + cleaned.slice(2);
      }
      if (cleaned.length <= MAX_PHONE_LENGTH) {
        setValue("phoneNumber", cleaned);
        // Remember the contact name for this number (if any) so the
        // "Frequently used" chip can show it after a purchase.
        if (name) {
          setContactLabel({ key: normalizeNumberKey(cleaned), name });
        }
      }
    },
    [setValue, setContactLabel],
  );

  return {
    control,
    setPhoneFromContact,
  };
}

export function useCategoryProducts() {
  const { data: categoryProducts, setNewData: setCategoryProducts } =
    useRQGlobalState<TProduct[]>({
      queryKey: CATEGORY_PRODUCTS_QUERY_KEY,
      initialData: [],
    });

  return {
    categoryProducts: categoryProducts ?? [],
    setCategoryProducts,
  };
}

export function usePhoneNumber() {
  const { data: phoneNumber } = useRQGlobalState<string>({
    queryKey: PHONE_NUMBER_QUERY_KEY,
    initialData: "",
  });

  const { categoryProducts } = useCategoryProducts();

  const safePhoneNumber = phoneNumber ?? "";

  const detectedProvider = useMemo<ProviderKey | null>(() => {
    return detectProvider(safePhoneNumber);
  }, [safePhoneNumber]);

  const detectedProductId = useMemo(() => {
    if (!detectedProvider || !categoryProducts.length) return null;

    const providerCode = PROVIDER_CONFIG[detectedProvider].code.toUpperCase();
    const matchedProduct = categoryProducts.find(
      (product) => product.code?.toUpperCase() === providerCode,
    );

    return matchedProduct?.id ?? null;
  }, [detectedProvider, categoryProducts]);

  const { data: productDetail, isLoading: isLoadingProductDetail } =
    useProductById(detectedProductId || "");

  const { data: inputFields, isLoading: isLoadingInputFields } =
    useProductInputFields(detectedProductId || "");

  // Find the phone number field key from input fields
  const phoneNumberFieldKey = useMemo(() => {
    if (!inputFields?.forms) return null;
    // Look for phone/number type field - check various possible type values
    const phoneField = inputFields.forms.find((f) => {
      const fieldType = f.type?.toUpperCase() || "";
      return (
        fieldType === "PHONE" ||
        fieldType === "NUMBER" ||
        fieldType === "NUMERIC" ||
        fieldType === "TEXT" ||
        fieldType.includes("PHONE") ||
        fieldType.includes("NUMBER")
      );
    });
    return phoneField?.key ?? null;
  }, [inputFields?.forms]);

  const providerInfo = detectedProvider
    ? PROVIDER_CONFIG[detectedProvider]
    : null;

  const isValidPhoneNumber = safePhoneNumber.length >= MIN_VALID_LENGTH;
  const showProviderNotDetected =
    !detectedProvider && safePhoneNumber.length >= MIN_PREFIX_LENGTH;
  const showMinLengthError =
    safePhoneNumber.length > 0 && safePhoneNumber.length < MIN_VALID_LENGTH;

  return {
    phoneNumber: safePhoneNumber,
    detectedProvider,
    productDetail,
    providerInfo,
    isLoading: isLoadingProductDetail || isLoadingInputFields,
    isValidPhoneNumber,
    showProviderNotDetected,
    showMinLengthError,
    phoneNumberFieldKey,
  };
}
