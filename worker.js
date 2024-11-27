const config = {
    // 配置项，用于控制各项功能
    result_page: false, // 获取 KV 值后是否使用页面显示结果
    theme: "", // 首页主题，空值为默认主题。要使用 urlcool 主题，填入 "theme/urlcool"
    cors: true, // 是否允许跨域资源共享（CORS）进行 API 请求
    unique_link: false, // 是否启用唯一链接，相同的长链接将映射到相同的短链接
    custom_link: true, // 是否允许用户自定义短链接
    overwrite_kv: false, // 是否允许用户覆盖已存在的键值对
    snapchat_mode: false, // 启用阅后即焚模式，链接访问后即销毁
    visit_count: false, // 是否统计访问次数
    load_kv: true, // 是否从 Cloudflare KV 加载所有数据
    system_type: "shorturl", // 系统类型，可能的值有 shorturl, imghost, pastebin, journal 等
  };
  
  // 保护的 key 列表，无法通过 UI 和 API 进行读取、添加或删除
  const protect_keylist = [
    "password", // 设置为 password 的 key 被保护
  ];
  
  // 配置 HTML 页面路径
  let index_html = `https://sanckole.github.io/Url-Shorten-Worker/${config.theme}/index.html`;
  let result_html = `https://sanckole.github.io/Url-Shorten-Worker/${config.theme}/result.html`;
  
  // 404 页面模板
  const html404 = `<!DOCTYPE html>
    <html>
    <body>
      <h1>404 Not Found.</h1>
      <p>The URL you visit is not found.</p>
      <p> <a href="https://ckole.com/" target="_self">my blog</a> </p>
    </body>
    </html>`;
  
  // 默认响应头，支持跨域和 JSON 格式的返回
  let response_header = {
    "Content-type": "text/html;charset=UTF-8;application/json",
  };
  
  // 如果启用了 CORS，添加相应的跨域头部
  if (config.cors) {
    response_header = {
      "Content-type": "text/html;charset=UTF-8;application/json",
      "Access-Control-Allow-Origin": "*", // 允许所有域名访问
      "Access-Control-Allow-Methods": "POST", // 允许 POST 请求
      "Access-Control-Allow-Headers": "Content-Type", // 允许的请求头
    };
  }
  
  /**
   * 将 Base64 字符串转换为 Blob 对象
   * @param {string} base64String Base64 编码的字符串
   * @returns {Blob} 转换后的 Blob 对象
   */
  function base64ToBlob(base64String) {
    const parts = base64String.split(';base64,');
    const contentType = parts[0].split(':')[1];
    const raw = atob(parts[1]);
    const uInt8Array = new Uint8Array(raw.length);
  
    for (let i = 0; i < raw.length; ++i) {
      uInt8Array[i] = raw.charCodeAt(i);
    }
    return new Blob([uInt8Array], { type: contentType });
  }
  
  /**
   * 生成指定长度的随机字符串
   * @param {number} len 字符串的长度，默认是 6
   * @returns {string} 随机生成的字符串
   */
  async function randomString(len = 6) {
    const chars = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678'; // 去掉了容易混淆的字符
    const maxPos = chars.length;
    let result = '';
  
    for (let i = 0; i < len; i++) {
      result += chars.charAt(Math.floor(Math.random() * maxPos));
    }
    return result;
  }
  
  /**
   * 使用 SHA-512 对 URL 进行哈希处理
   * @param {string} url 要哈希处理的 URL
   * @returns {string} 返回 URL 的 SHA-512 哈希值
   */
  async function sha512(url) {
    const encodedUrl = new TextEncoder().encode(url);
    const urlDigest = await crypto.subtle.digest({ name: "SHA-512" }, encodedUrl);
    const hashArray = Array.from(new Uint8Array(urlDigest));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  /**
   * 检查 URL 是否符合合法的格式
   * @param {string} URL 要检查的 URL
   * @returns {boolean} 如果 URL 合法返回 true，否则返回 false
   */
  async function checkURL(URL) {
    const expression = /http(s)?:\/\/([\w-]+\.)+[\w-]+(\/[\w- .\/?%&=]*)?/;
    const objExp = new RegExp(expression);
  
    return objExp.test(URL) && URL[0] === 'h';
  }
  
  /**
   * 将 URL 保存到 KV 存储中，使用随机生成的 key
   * @param {string} URL 要保存的长 URL
   * @returns {Promise<string>} 返回生成的短链接 key
   */
  async function save_url(URL) {
    const randomKey = await randomString();
    const isExist = await LINKS.get(randomKey);
  
    if (isExist === null) {
      await LINKS.put(randomKey, URL);
      return randomKey;
    } else {
      return save_url(URL); // 如果 key 已存在，递归调用以生成新的 key
    }
  }
  
  /**
   * 检查 URL 的哈希值对应的短链接是否存在
   * @param {string} url_sha512 URL 的 SHA-512 哈希值
   * @returns {Promise<string | null>} 如果存在对应的短链接，返回短链接，否则返回 null
   */
  async function is_url_exist(url_sha512) {
    const isExist = await LINKS.get(url_sha512);
    return isExist ? isExist : null;
  }
  
  /**
   * 处理请求的主函数
   * @param {Request} request 请求对象
   * @returns {Response} 响应对象
   */
  async function handleRequest(request) {
    // 从 KV 获取 "password" 对应的值
    const passwordValue = await LINKS.get("password");
  
    /************************/
    // 以下是 API 接口的处理
    if (request.method === "POST") {
      const req = await request.json();
      const { cmd, url, key, password } = req;
  
      // 验证密码
      if (password !== passwordValue) {
        return new Response(`{"status":500,"key": "", "error":"Error: Invalid password."}`, {
          headers: response_header,
        });
      }
  
      // 添加短链接
      if (cmd === "add") {
        // URL 合法性检查
        if (config.system_type === "shorturl" && !await checkURL(url)) {
          return new Response(`{"status":500, "url": "${url}", "error":"Error: Url illegal."}`, {
            headers: response_header,
          });
        }
  
        let randomKey;
  
        if (config.custom_link && key !== "") {
          // 如果启用了自定义短链接，检查该 key 是否已被保护或已存在
          if (protect_keylist.includes(key)) {
            return new Response(`{"status":500,"key": "${key}", "error":"Error: Key in protect_keylist."}`, {
              headers: response_header,
            });
          }
  
          const isExist = await is_url_exist(key);
          if ((!config.overwrite_kv) && isExist) {
            return new Response(`{"status":500,"key": "${key}", "error":"Error: Specific key existed."}`, {
              headers: response_header,
            });
          } else {
            randomKey = key;
            await LINKS.put(key, url); // 保存 URL 到 KV
          }
        } else if (config.unique_link) {
          // 如果启用了唯一链接功能，使用 URL 的哈希值作为 key
          const urlSha512 = await sha512(url);
          let urlKey = await is_url_exist(urlSha512);
  
          if (urlKey) {
            randomKey = urlKey;
          } else {
            randomKey = await save_url(url);
            await LINKS.put(urlSha512, randomKey);
          }
        } else {
          randomKey = await save_url(url);
        }
  
        return new Response(`{"status":200, "key":"${randomKey}", "error": ""}`, {
          headers: response_header,
        });
      }
  
      // 删除短链接
      else if (cmd === "del") {
        if (protect_keylist.includes(key)) {
          return new Response(`{"status":500, "key": "${key}", "error":"Error: Key in protect_keylist."}`, {
            headers: response_header,
          });
        }
  
        await LINKS.delete(key);
  
        // 如果开启了访问计数功能，也删除计数记录
        if (config.visit_count) {
          await LINKS.delete(`${key}-count`);
        }
  
        return new Response(`{"status":200, "key": "${key}", "error": ""}`, {
          headers: response_header,
        });
      }
  
      // 查询短链接的 URL
      else if (cmd === "qry") {
        if (protect_keylist.includes(key)) {
          return new Response(`{"status":500,"key": "${key}", "error":"Error: Key in protect_keylist."}`, {
            headers: response_header,
          });
        }
  
        const value = await LINKS.get(key);
        if (value !== null) {
          return new Response(JSON.stringify({
            status: 200, 
            error: "", 
            key: key, 
            url: value
          }), {
            headers: response_header,
          });
        } else {
          return new Response(`{"status":500, "key": "${key}", "error":"Error: Key not exist."}`, {
            headers: response_header,
          });
        }
      }
  
      // 查询所有短链接
      else if (cmd === "qryall") {
        if (!config.load_kv) {
          return new Response(`{"status":500, "error":"Error: Config.load_kv false."}`, {
            headers: response_header,
          });
        }
  
        const keyList = await LINKS.list();
        if (keyList !== null) {
          const jsonObjectRetrun = {
            status: 200, 
            error: "", 
            kvlist: keyList.keys.filter(item => !protect_keylist.includes(item.name) && !item.name.endsWith("-count"))
                                  .map(item => ({ key: item.name, value: await LINKS.get(item.name) }))
          };
          return new Response(JSON.stringify(jsonObjectRetrun), {
            headers: response_header,
          });
        } else {
          return new Response(`{"status":500, "error":"Error: Load keyList failed."}`, {
            headers: response_header,
          });
        }
      }
    }
  
    /************************/
    // 以下是浏览器直接访问 worker 页面时的处理
    const requestURL = new URL(request.url);
    let path = requestURL.pathname.split("/")[1];
    path = decodeURIComponent(path);
    const params = requestURL.search;
  
    // 如果没有 path，直接访问 worker，跳转到主页
    if (!path) {
      return Response.redirect("https://ckole.com/", 301);
    }
  
    // 如果访问的是 "password" 页面，返回操作页面
    if (path === passwordValue) {
      let index = await fetch(index_html);
      index = await index.text();
      index = index.replace(/__PASSWORD__/gm, passwordValue);
      return new Response(index, {
        headers: response_header,
      });
    }
  
    // 查询 KV 中的短链接对应的长链接
    let value = await LINKS.get(path);
    if (protect_keylist.includes(path)) {
      value = ""; // 保护的 key 返回空值
    }
  
    if (!value) {
      return new Response(html404, {
        headers: response_header,
        status: 404,
      });
    }
  
    // 如果启用了访问计数，增加访问次数
    if (config.visit_count) {
      let count = await LINKS.get(`${path}-count`);
      count = count === null ? 1 : parseInt(count) + 1;
      await LINKS.put(`${path}-count`, count.toString());
    }
  
    // 如果启用了阅后即焚模式，访问后删除短链接
    if (config.snapchat_mode) {
      await LINKS.delete(path);
    }
  
    // 拼接最终的跳转 URL，带上查询参数
    if (params) {
      value += params;
    }
  
    // 如果启用了自定义结果页面
    if (config.result_page) {
      let resultPageHtml = await fetch(result_html);
      let resultPageHtmlText = await resultPageHtml.text();
      resultPageHtmlText = resultPageHtmlText.replace(/{__FINAL_LINK__}/gm, value);
      return new Response(resultPageHtmlText, {
        headers: response_header,
      });
    }
  
    // 默认跳转行为
    if (config.system_type === "shorturl") {
      return Response.redirect(value, 301); // 短链接跳转
    } else if (config.system_type === "imghost") {
      // 图床系统，返回图片内容
      const blob = base64ToBlob(value);
      return new Response(blob);
    } else {
      // 其他系统，直接显示 value
      return new Response(value, {
        headers: response_header,
      });
    }
  }
  
  addEventListener("fetch", async event => {
    event.respondWith(handleRequest(event.request));
  });
  