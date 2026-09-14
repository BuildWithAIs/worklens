export const features = [
  {
    title: "任务在本机推进",
    description:
      "读取和编辑本地文件，执行命令。工具执行结果留在会话里，方便回看任务做了什么、进行到了哪里。",
  },
  {
    title: "每项工作各有上下文",
    description:
      "为不同任务建立独立会话，在多段工作之间切换。会话历史保存在本机，下次打开还能继续。",
  },
  {
    title: "模型由你选择",
    description:
      "连接自己的模型服务，设置默认模型，也可按会话切换模型与推理等级。凭据通过操作系统加密保存。",
  },
] as const;

export const gettingStartedSteps = [
  {
    title: "获取源码并启动",
    description: "按仓库说明安装依赖，启动桌面应用。",
  },
  {
    title: "连接你的模型服务",
    description: "在设置中完成认证，保存默认模型并测试连接。",
  },
  {
    title: "描述一个具体任务",
    description: "新建会话，给出目标和文件路径，查看执行过程。",
  },
] as const;

export const faqs = [
  {
    question: "WorkLens 是什么？",
    answer:
      "它是运行在电脑上的工作 Agent，围绕对话组织本地文件处理与任务执行。项目面向中大型企业员工的日常工作，目前处于早期开发阶段。",
  },
  {
    question: "本地优先，意味着完全离线吗？",
    answer:
      "不意味着完全离线。会话历史与设置保存在本机，凭据由操作系统加密；使用远程模型时，请求内容及相关上下文仍会发送给你选择的模型服务商。本地工具以你的系统用户权限运行。",
  },
  {
    question: "使用需要付费吗？",
    answer:
      "项目以 MIT 协议开放源码。模型服务需要你自行配置，相关费用与使用条款由所选服务商决定。",
  },
  {
    question: "已支持企业服务连接和长期记忆吗？",
    answer:
      "Jira、Confluence、GitHub 等企业工作场景是产品的方向，目前没有内置这些服务的一键连接。长期记忆也仍在规划中，当前提供的是本机会话历史。",
  },
] as const;
