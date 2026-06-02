export default {
  async email(message, env) {
    const safeForward = async (recipient) => {
      try {
        await message.forward(recipient);
        console.log(JSON.stringify({
          event: 'forward_ok',
          to: recipient,
          inbound: message.to
        }));
        return true;
      } catch (err) {
        console.error(JSON.stringify({
          event: 'forward_failed',
          to: recipient,
          inbound: message.to,
          err: err && err.message,
          stack: err && err.stack
        }));
        return false;
      }
    };

    // Lazy fallback resolution. undefined = not yet fetched, null = fetched but unavailable, string = ready to use.
    let fallbackAddress = undefined;
    const resolveFallback = async () => {
      if (fallbackAddress !== undefined) return fallbackAddress;
      try {
        const kvFallback = await env.tef_map.get('_fallback');
        if (typeof kvFallback === 'string' && kvFallback.trim().length > 0) {
          fallbackAddress = kvFallback.trim().toLowerCase();
        } else {
          console.error(JSON.stringify({
            event: 'fallback_unavailable',
            reason: 'missing_or_invalid',
            kv_value: kvFallback,
            inbound: message.to
          }));
          fallbackAddress = null;
        }
      } catch (err) {
        console.error(JSON.stringify({
          event: 'fallback_unavailable',
          reason: 'kv_read_failed',
          err: err && err.message,
          inbound: message.to
        }));
        fallbackAddress = null;
      }
      return fallbackAddress;
    };

    const deliverToFallback = async (reason) => {
      const addr = await resolveFallback();
      if (!addr) {
        console.error(JSON.stringify({
          event: 'fallback_unavailable',
          reason: 'no_address',
          trigger_reason: reason,
          inbound: message.to,
          message_lost: true
        }));
        return;
      }
      console.log(JSON.stringify({
        event: 'fallback_triggered',
        to: addr,
        reason: reason,
        inbound: message.to
      }));
      await safeForward(addr);
    };

    try {
      if (typeof message.to !== 'string') {
        console.error(JSON.stringify({
          event: 'invalid_to',
          type: typeof message.to,
          value: message.to
        }));
        await deliverToFallback('invalid_to');
        return;
      }

      const toAddress = message.to.toLowerCase();
      const localPart = toAddress.split('@')[0];
      console.log(JSON.stringify({
        event: 'email_received',
        inbound: toAddress,
        from: message.from,
        local_part: localPart
      }));

      let fistMappingsRaw = null;
      let miscMappingsRaw = null;
      try {
        [fistMappingsRaw, miscMappingsRaw] = await Promise.all([
          env.tef_map.get('fist', 'json'),
          env.tef_map.get('misc', 'json')
        ]);
      } catch (err) {
        console.error(JSON.stringify({
          event: 'kv_read_failed',
          err: err && err.message,
          inbound: toAddress
        }));
      }

      if (fistMappingsRaw === null) {
        console.error(JSON.stringify({
          event: 'mapping_invalid',
          key: 'fist',
          value: null,
          inbound: toAddress
        }));
      }
      if (miscMappingsRaw === null) {
        console.error(JSON.stringify({
          event: 'mapping_invalid',
          key: 'misc',
          value: null,
          inbound: toAddress
        }));
      }

      const normalize = (obj, sourceLabel) => {
        if (!obj || typeof obj !== 'object') return {};
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
          if (typeof k !== 'string' || !Array.isArray(v)) {
            console.error(JSON.stringify({
              event: 'entry_dropped',
              source: sourceLabel,
              key: k,
              reason: 'invalid_structure',
              value_type: typeof v,
              inbound: toAddress
            }));
            continue;
          }
          const cleanKey = k.trim().toLowerCase();
          const cleanRecipients = v
            .filter(r => typeof r === 'string')
            .map(r => r.trim().toLowerCase())
            .filter(r => r.length > 0);
          if (cleanKey.length === 0) {
            console.error(JSON.stringify({
              event: 'entry_dropped',
              source: sourceLabel,
              reason: 'empty_key_after_trim',
              inbound: toAddress
            }));
            continue;
          }
          if (cleanRecipients.length === 0) {
            console.error(JSON.stringify({
              event: 'entry_dropped',
              source: sourceLabel,
              key: cleanKey,
              reason: 'no_valid_recipients',
              inbound: toAddress
            }));
            continue;
          }
          out[cleanKey] = cleanRecipients;
        }
        return out;
      };

      const fistMappings = normalize(fistMappingsRaw, 'fist');
      const miscMappings = normalize(miscMappingsRaw, 'misc');

      const combinedMappings = {};
      for (const src of [fistMappings, miscMappings]) {
        for (const [k, v] of Object.entries(src)) {
          combinedMappings[k] = [...(combinedMappings[k] || []), ...v];
        }
      }

      const recipientAddresses = new Set();
      for (const keyword of Object.keys(combinedMappings)) {
        if (localPart.includes(keyword)) {
          combinedMappings[keyword].forEach(r => recipientAddresses.add(r));
          console.log(JSON.stringify({
            event: 'match',
            keyword: keyword,
            recipients: combinedMappings[keyword],
            inbound: toAddress
          }));
        }
      }

      if (recipientAddresses.size === 0) {
        console.error(JSON.stringify({
          event: 'no_match',
          inbound: toAddress,
          local_part: localPart
        }));
        await deliverToFallback('no_match');
        return;
      }

      const recipientList = [...recipientAddresses];
      const results = await Promise.allSettled(
        recipientList.map(r => safeForward(r))
      );

      const failures = results.map((r, idx) => {
        if (r.status === 'rejected') {
          return {
            recipient: recipientList[idx],
            kind: 'rejected',
            err: r.reason && r.reason.message
          };
        }
        if (r.value === false) {
          return {
            recipient: recipientList[idx],
            kind: 'returned_false'
          };
        }
        return null;
      }).filter(Boolean);

      if (failures.length > 0) {
        console.error(JSON.stringify({
          event: 'partial_failure',
          inbound: toAddress,
          failures: failures,
          routing_to_fallback: true
        }));
        await deliverToFallback('partial_failure');
      }
    } catch (err) {
      console.error(JSON.stringify({
        event: 'unhandled_error',
        err: err && err.message,
        stack: err && err.stack,
        inbound: message && message.to
      }));
      try {
        await deliverToFallback('unhandled_error');
      } catch (fallbackErr) {
        console.error(JSON.stringify({
          event: 'fallback_threw',
          err: fallbackErr && fallbackErr.message,
          inbound: message && message.to,
          message_lost: true
        }));
      }
    }
  }
};