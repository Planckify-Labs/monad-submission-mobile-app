# 😕 TakumiPay Technical Debt
## add chainIdFromDb to activeChain in useWallet hooks
### what's the catch?
check this AI generated shit codes broh
```typescript
  const { data: blockchains } = useBlockchains();
  const activeBlockchain = useMemo(() => {
    if (!blockchains || !activeChain) return null;
    return blockchains.find((b) => b.chainId === activeChain.chain.id); // we do this operation just to fet the blockchain id from the database!
  }, [blockchains, activeChain]);

  const { data: tokens } = useTokens({
    blockchainId: activeBlockchain?.id, // this could be more efficient if we can get chainIdFromDb from the activeChain so no need to fetch a list of blockchains when we want to fetch tokens based on active blockchain id
    isStablecoin: true,
    isActive: true,
  });
```
but dont worry on the useWallet hooks it's even more worst code 🤣

## enable R8/minification for release builds (Play Console: DEX optimization below threshold, fix by Feb 2027)
### what's the catch?
`android/app/build.gradle` gates R8 behind `android.enableMinifyInReleaseBuilds` /
`android.enableShrinkResourcesInReleaseBuilds` gradle properties (both default
`false`), and there's no `expo-build-properties` plugin in `app.config.ts` to
turn them on — release builds have never run R8. `android/app/proguard-rules.pro`
is only ~14 lines, basically the stock template, with no keep-rules for any of
our native modules (Solana Mobile Wallet Adapter / walletlib, WalletConnect,
Google Sign-In, expo-secure-store, biometrics, MMKV, Firebase/FCM).

Turning it on is not a one-line flip: add `expo-build-properties` with both
flags true, then work through a full release-mode device regression pass
across wallet creation/import, WalletConnect pairing + signing, biometric
unlock, push notifications, and Google Sign-In — missing keep-rules show up as
silent `ClassNotFoundException`/`NoSuchMethodError` crashes only in the
minified build, not in dev. Deliberately deferred (2026-09-13) given the long
runway to the Feb 2027 deadline; do this as its own initiative, not bundled
into an unrelated release.