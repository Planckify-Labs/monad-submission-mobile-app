import { router } from "expo-router";
import React from "react";
import { StyleSheet, Text } from "react-native";
import Markdown from "react-native-markdown-display";
import { classifyURI } from "@/services/deeplinks/router";
import { useMarkdownStyles } from "./useMarkdownStyles";

interface MarkdownMessageProps {
  content: string;
}

/**
 * Every link the agent renders opens in TakumiPay's own dApp browser, not
 * the system browser. Mirrors `useExternalDappLinking` / `handleDeepLink`:
 * a bare http(s) link to a third-party host routes to `/dapps-browser`;
 * our own verified host and non-web schemes (`mailto:`, `tel:`, …) fall
 * through to the default handler so expo-router's universal linking still
 * owns them.
 *
 * Returning `false` tells `react-native-markdown-display` to skip its
 * `Linking.openURL` fallback (see the lib's `util/openUrl.js`); returning
 * `true` lets that fallback run.
 */
function openLinkInAppBrowser(href: string): boolean {
  const url = /^[a-z][\w+.-]*:/i.test(href) ? href : `https://${href}`;
  const result = classifyURI(url);
  if (result.type === "dapp" && result.url) {
    router.push({ pathname: "/dapps-browser", params: { url: result.url } });
    return false;
  }
  return true;
}

const MarkdownMessage: React.FC<MarkdownMessageProps> = ({ content }) => {
  const markdownStyles = useMarkdownStyles();

  try {
    return (
      <Markdown
        style={markdownStyles as StyleSheet.NamedStyles<any>}
        onLinkPress={openLinkInAppBrowser}
      >
        {content || "This message includes content we can't display yet."}
      </Markdown>
    );
  } catch (error) {
    console.error("Markdown rendering error:", error);
    return (
      <Text className="text-sm leading-5 text-light-matte-black">
        {content || "This message includes content we can't display yet."}
      </Text>
    );
  }
};

export default MarkdownMessage;
