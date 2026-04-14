import React, { useEffect, useRef, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCurrentUser } from '@/hooks/useCurrentUser';
import { useNostrPublish } from '@/hooks/useNostrPublish';
import { useToast } from '@/hooks/useToast';
import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Loader2, Camera, Zap, Upload } from 'lucide-react';
import { NSchema as n, type NostrMetadata } from '@nostrify/nostrify';
import { useQueryClient } from '@tanstack/react-query';
import { useUploadFile } from '@/hooks/useUploadFile';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { STORAGE_KEYS } from '@/lib/storageKeys';
import { Slider } from '@/components/ui/slider';
import { cacheProfile } from '@/lib/cacheStore';

/** Placeholder banner: green hills + blue sky gradient */
function BannerPlaceholder() {
  return (
    <div className="w-full h-full relative overflow-hidden">
      {/* Sky */}
      <div className="absolute inset-0 bg-gradient-to-b from-sky-400 via-sky-300 to-sky-200 dark:from-sky-700 dark:via-sky-600 dark:to-sky-500" />
      {/* Clouds */}
      <div className="absolute top-3 left-[15%] w-16 h-5 bg-white/40 dark:bg-white/20 rounded-full blur-sm" />
      <div className="absolute top-5 left-[60%] w-12 h-4 bg-white/30 dark:bg-white/15 rounded-full blur-sm" />
      {/* Hills */}
      <svg className="absolute bottom-0 w-full" viewBox="0 0 400 80" preserveAspectRatio="none" style={{ height: '50%' }}>
        <ellipse cx="100" cy="80" rx="180" ry="60" className="fill-green-400 dark:fill-green-700" />
        <ellipse cx="320" cy="80" rx="160" ry="50" className="fill-green-500 dark:fill-green-800" />
        <ellipse cx="200" cy="80" rx="220" ry="40" className="fill-green-600 dark:fill-green-900" />
      </svg>
    </div>
  );
}

/** Placeholder avatar: shadowman silhouette */
function AvatarPlaceholder() {
  return (
    <div className="w-full h-full bg-gradient-to-b from-gray-300 to-gray-400 dark:from-gray-600 dark:to-gray-700 flex items-center justify-center">
      <svg viewBox="0 0 100 100" className="w-3/4 h-3/4 opacity-40">
        <circle cx="50" cy="35" r="18" fill="currentColor" />
        <ellipse cx="50" cy="85" rx="30" ry="22" fill="currentColor" />
      </svg>
    </div>
  );
}

interface ProfileFormData extends NostrMetadata {
  display_name?: string;
  lud16?: string;
}

export function EditProfileForm({ onSaved }: { onSaved?: () => void }) {
  const queryClient = useQueryClient();
  const { user, metadata } = useCurrentUser();
  const { mutateAsync: publishEvent, isPending } = useNostrPublish();
  const { mutateAsync: uploadFile, isPending: isUploading } = useUploadFile();
  const { toast } = useToast();

  const bannerInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<ProfileFormData>({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- zodResolver expects ZodType<any> which is incompatible with nostrify's Zod version
    resolver: zodResolver(n.metadata() as any),
    defaultValues: {
      display_name: '',
      name: '',
      about: '',
      picture: '',
      banner: '',
      website: '',
      nip05: '',
      lud16: '',
      bot: false,
    },
  });

  useEffect(() => {
    if (metadata) {
      form.reset({
        display_name: metadata.display_name || '',
        name: metadata.name || '',
        about: metadata.about || '',
        picture: metadata.picture || '',
        banner: metadata.banner || '',
        website: metadata.website || '',
        nip05: metadata.nip05 || '',
        lud16: metadata.lud16 || '',
        bot: metadata.bot || false,
      });
    }
  }, [metadata, form]);

  const handleUpload = async (file: File, field: 'picture' | 'banner') => {
    try {
      const [[, url]] = await uploadFile(file);
      form.setValue(field, url);
    } catch (error) {
      console.error(`Failed to upload ${field}:`, error);
      toast({
        title: 'Upload failed',
        description: `Could not upload ${field === 'picture' ? 'avatar' : 'banner'}. Try again.`,
        variant: 'destructive',
      });
    }
  };

  const onSubmit = async (values: ProfileFormData) => {
    if (!user) return;
    try {
      const data = { ...metadata, ...values };
      for (const key in data) {
        if (data[key] === '') delete data[key];
      }

      const event = await publishEvent({ kind: 0, content: JSON.stringify(data) });
      console.log('[EditProfile] Published kind 0:', event.id, 'pubkey:', event.pubkey);

      // Optimistically update the local cache + query so the UI reflects
      // the new profile immediately without waiting for a relay round-trip.
      const parsedMeta = n.json().pipe(n.metadata()).parse(event.content);
      cacheProfile(user.pubkey, parsedMeta, event).catch(() => {});
      queryClient.setQueryData(['author', user.pubkey], { metadata: parsedMeta, event });
      queryClient.invalidateQueries({ queryKey: ['logins'] });
      toast({ title: 'Profile saved', description: 'Published to Nostr relays.' });
      onSaved?.();
    } catch (error) {
      console.error('Failed to update profile:', error);
      toast({ title: 'Failed to update profile', variant: 'destructive' });
    }
  };

  const bannerUrl = form.watch('banner');
  const pictureUrl = form.watch('picture');

  // Banner display settings (local, not published to Nostr)
  const [bannerHeightPct, setBannerHeightPct] = useLocalStorage<number>(STORAGE_KEYS.BANNER_HEIGHT_PCT, 0);
  const [bannerFitMode, setBannerFitMode] = useLocalStorage<string>(STORAGE_KEYS.BANNER_FIT_MODE, 'crop');
  // Measure natural aspect ratio of the uploaded banner to use as default
  const [naturalPct, setNaturalPct] = React.useState<number>(0);
  const effectivePct = bannerHeightPct === 0 ? naturalPct : bannerHeightPct;

  // Track if banner display settings changed so we can toast on close
  const initialBannerSettings = useRef({ heightPct: bannerHeightPct, fitMode: bannerFitMode });
  const bannerSettingsChanged = useRef(false);
  const wrappedSetHeight = useCallback((v: number) => {
    setBannerHeightPct(v);
    bannerSettingsChanged.current = true;
  }, [setBannerHeightPct]);
  const wrappedSetFit = useCallback((v: string) => {
    setBannerFitMode(v);
    bannerSettingsChanged.current = true;
  }, [setBannerFitMode]);

  // Toast on unmount if banner settings were adjusted
  useEffect(() => {
    return () => {
      if (bannerSettingsChanged.current) {
        toast({ title: 'Banner display updated' });
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        {/* Visual banner + avatar header */}
        <div className="relative">
          {/* Banner */}
          <input ref={bannerInputRef} type="file" accept="image/*" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f, 'banner'); e.target.value = ''; }} />
          <div
            className="w-full rounded-lg overflow-hidden cursor-pointer relative group"
            style={effectivePct > 0 ? { paddingBottom: `${effectivePct}%` } : { height: bannerUrl ? 'auto' : '7rem' }}
            onClick={() => bannerInputRef.current?.click()}
          >
            {bannerUrl ? (
              effectivePct > 0 ? (
                <img
                  src={bannerUrl} alt=""
                  className={`absolute inset-0 w-full h-full ${bannerFitMode === 'crop' ? 'object-cover' : 'object-contain'}`}
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    if (img.naturalWidth > 0) setNaturalPct(Math.round((img.naturalHeight / img.naturalWidth) * 100));
                  }}
                />
              ) : (
                <img
                  src={bannerUrl} alt="" className="w-full h-auto"
                  onLoad={(e) => {
                    const img = e.currentTarget;
                    if (img.naturalWidth > 0) setNaturalPct(Math.round((img.naturalHeight / img.naturalWidth) * 100));
                  }}
                />
              )
            ) : (
              <div className={effectivePct > 0 ? 'absolute inset-0' : 'h-full'}><BannerPlaceholder /></div>
            )}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
              <Camera className="h-5 w-5 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>

          {/* Avatar overlapping banner */}
          <input ref={avatarInputRef} type="file" accept="image/*" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f, 'picture'); e.target.value = ''; }} />
          <div
            className="absolute -bottom-5 sm:-bottom-8 left-4 w-10 h-10 sm:w-20 sm:h-20 rounded-full border-2 sm:border-4 border-background overflow-hidden cursor-pointer group"
            onClick={(e) => { e.stopPropagation(); avatarInputRef.current?.click(); }}
          >
            {pictureUrl ? (
              <img src={pictureUrl} alt="" className="w-full h-full object-cover" />
            ) : (
              <AvatarPlaceholder />
            )}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center rounded-full">
              <Camera className="h-4 w-4 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        </div>

        {/* Spacer for overlapping avatar */}
        <div className="h-3 sm:h-6" />

        {/* Banner display settings */}
        {bannerUrl && (
          <div className="space-y-2 p-3 bg-muted/50 rounded-lg">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Banner height</span>
              <span className="text-xs text-muted-foreground">
                {bannerHeightPct === 0 ? `Auto (${naturalPct}%)` : `${bannerHeightPct}%`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground w-7">Auto</span>
              <Slider
                min={0} max={75} step={1}
                value={[bannerHeightPct]}
                onValueChange={([v]) => wrappedSetHeight(v)}
                className="flex-1"
              />
              <span className="text-[10px] text-muted-foreground w-5">75%</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium">Fit mode</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  className={`text-xs px-2 py-0.5 rounded ${bannerFitMode === 'crop' ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'}`}
                  onClick={() => wrappedSetFit('crop')}
                >Crop</button>
                <button
                  type="button"
                  className={`text-xs px-2 py-0.5 rounded ${bannerFitMode === 'scale' ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80'}`}
                  onClick={() => wrappedSetFit('scale')}
                >Scale</button>
              </div>
            </div>
          </div>
        )}

        {/* URL inputs + upload buttons for banner/avatar */}
        <div className="grid grid-cols-2 gap-3">
          <FormField control={form.control} name="picture" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Avatar</FormLabel>
              <div className="flex gap-1">
                <FormControl><Input placeholder="https://..." className="text-xs h-8 flex-1" {...field} /></FormControl>
                <Button type="button" variant="outline" size="sm" className="h-8 px-2 shrink-0" disabled={isUploading} onClick={() => avatarInputRef.current?.click()}>
                  {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="banner" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-xs">Banner</FormLabel>
              <div className="flex gap-1">
                <FormControl><Input placeholder="https://..." className="text-xs h-8 flex-1" {...field} /></FormControl>
                <Button type="button" variant="outline" size="sm" className="h-8 px-2 shrink-0" disabled={isUploading} onClick={() => bannerInputRef.current?.click()}>
                  {isUploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                </Button>
              </div>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        {/* Name fields */}
        <div className="grid grid-cols-2 gap-3">
          <FormField control={form.control} name="display_name" render={({ field }) => (
            <FormItem>
              <FormLabel>Display Name</FormLabel>
              <FormControl><Input placeholder="How you appear to others" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="name" render={({ field }) => (
            <FormItem>
              <FormLabel>Username</FormLabel>
              <FormControl><Input placeholder="short_handle" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        {/* Bio */}
        <FormField control={form.control} name="about" render={({ field }) => (
          <FormItem>
            <FormLabel>Bio</FormLabel>
            <FormControl><Textarea placeholder="Tell others about yourself" className="resize-none min-h-[60px]" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Identity & links */}
        <div className="grid grid-cols-2 gap-3">
          <FormField control={form.control} name="nip05" render={({ field }) => (
            <FormItem>
              <FormLabel>NIP-05</FormLabel>
              <FormControl><Input placeholder="you@example.com" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="website" render={({ field }) => (
            <FormItem>
              <FormLabel>Website</FormLabel>
              <FormControl><Input placeholder="https://..." {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        {/* Lightning & bot */}
        <div className="grid grid-cols-2 gap-3">
          <FormField control={form.control} name="lud16" render={({ field }) => (
            <FormItem>
              <FormLabel className="flex items-center gap-1"><Zap className="h-3 w-3 text-amber-500" />Lightning Address</FormLabel>
              <FormControl><Input placeholder="you@walletofsatoshi.com" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="bot" render={({ field }) => (
            <FormItem className="flex flex-row items-end gap-3 pb-2">
              <div className="space-y-0.5">
                <FormLabel>Bot</FormLabel>
              </div>
              <FormControl>
                <Switch checked={field.value} onCheckedChange={field.onChange} />
              </FormControl>
            </FormItem>
          )} />
        </div>

        <Button type="submit" className="w-full" disabled={isPending || isUploading}>
          {(isPending || isUploading) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Profile
        </Button>
      </form>
    </Form>
  );
}
